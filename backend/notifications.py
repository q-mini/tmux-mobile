"""Private question inbox and standards-based Web Push, independent of open pages."""
import asyncio
import base64
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import secrets
import time
from urllib.parse import urlsplit

import aiohttp
from aiohttp import web
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pywebpush import webpush_async, WebPushException

from .agent_identity import identify

LOG = logging.getLogger('tmux-mobile')
PUSH_HOSTS = {'web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com'}


def encoded(value):
    return base64.urlsafe_b64encode(value).decode().rstrip('=')


def private_write(path, value):
    temporary = path.with_name(path.name + '.' + secrets.token_hex(6))
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(value)
    temporary.replace(path)


def subscription(value):
    try:
        if not isinstance(value, dict):
            raise ValueError()
        endpoint = value['endpoint']
        if not isinstance(endpoint, str) or len(endpoint) > 4096:
            raise ValueError()
        url = urlsplit(endpoint)
        if (url.scheme != 'https' or url.hostname not in PUSH_HOSTS or url.port not in (None, 443)
                or url.username or url.password or url.fragment or not url.path or url.path == '/'):
            raise ValueError()
        keys = value['keys']
        decoded = {}
        for name, size in [('p256dh', 65), ('auth', 16)]:
            key = keys[name]
            if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,100}={0,2}', key):
                raise ValueError()
            decoded[name] = base64.urlsafe_b64decode(key + '=' * (-len(key) % 4))
            if len(decoded[name]) != size:
                raise ValueError()
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), decoded['p256dh'])
        return {'endpoint': endpoint, 'keys': {name: encoded(data) for name, data in decoded.items()}}
    except (ValueError, TypeError, KeyError):
        raise web.HTTPBadRequest(text='기기의 알림 구독을 확인할 수 없어요. 알림 켜기를 다시 눌러 주세요.')


class Notifications:
    def __init__(self, state, fleet, origins, sender=webpush_async):
        self.state, self.fleet, self.origins, self.sender = Path(state), fleet, origins, sender
        self.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = self.state / 'notifications.json'
        self.key_path = self.state / 'push-private.pem'
        if not self.key_path.exists():
            key = ec.generate_private_key(ec.SECP256R1())
            private_write(self.key_path, key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        self.key_path.chmod(0o600)
        key = serialization.load_pem_private_key(self.key_path.read_bytes(), password=None)
        self.public_key = encoded(key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))
        try:
            data = json.loads(self.path.read_text())
        except (FileNotFoundError, ValueError):
            data = {}
        self.items = data.get('items', [])[:100]
        self.devices = data.get('devices', {})
        self.active = data.get('active', {})
        self.missing = {}
        self.queue = asyncio.Queue(maxsize=100)
        self.revision = secrets.token_hex(12)
        self.test_times = {}
        self.last_push = data.get('last_push', 0)
        self.push_error = ''
        self.client = None
        # Tests may replace this with a task-owned pane; production uses CLI identity.
        self.candidate = lambda pane: pane.get('command') in {'claude', 'codex', 'node'}

    def save(self):
        self.items = [item for item in self.items if item['created_at'] > time.time() - 14 * 86400][:100]
        private_write(self.path, json.dumps({'items': self.items, 'devices': self.devices, 'active': self.active,
                                           'last_push': self.last_push}, ensure_ascii=False).encode())
        self.revision = secrets.token_hex(12)

    def listing(self, version=''):
        return {'changed': version != self.revision, 'version': self.revision,
                'items': self.items if version != self.revision else [],
                'unread': sum(not item['read'] for item in self.items),
                'push': {'public_key': self.public_key, 'last_sent': self.last_push, 'error': self.push_error}}

    def read(self, ids):
        if ids != 'all' and (not isinstance(ids, list) or len(ids) > 100 or not all(isinstance(item, str) for item in ids)):
            raise web.HTTPBadRequest(text='읽을 알림을 확인해 주세요.')
        for item in self.items:
            if ids == 'all' or item['id'] in ids:
                item['read'] = True
        self.save()
        return self.listing()

    def subscribe(self, source):
        value = subscription(source)
        key = hashlib.sha256(value['endpoint'].encode()).hexdigest()[:32]
        if key not in self.devices and len(self.devices) >= 16:
            raise web.HTTPTooManyRequests(text='알림을 받는 기기가 너무 많아요. 사용하지 않는 기기의 알림을 꺼 주세요.')
        self.devices[key] = value
        self.save()
        return {'ok': True, 'id': key}

    def unsubscribe(self, key):
        if not isinstance(key, str) or not re.fullmatch(r'[0-9a-f]{32}', key):
            raise web.HTTPBadRequest(text='알림 기기를 확인해 주세요.')
        self.devices.pop(key, None)
        self.save()
        return {'ok': True}

    async def agent(self, session, pane):
        if pane.get('command') in {'claude', 'codex'}:
            return pane['command'].capitalize()
        host = self.fleet.hosts[pane['host']]
        actor = await asyncio.to_thread(identify, pane['pid']) if host.local else await host.agent(pane['pid'])
        return actor or '터미널'

    async def observe(self, session, pane, frame):
        target = pane['id']
        if not frame:
            misses = self.missing.get(target, 0) + 1
            self.missing[target] = min(misses, 2)
            if misses >= 2 and target in self.active:
                self.active.pop(target)
                self.save()
            return
        self.missing.pop(target, None)
        identity = [pane['pid'], frame['kind'], frame['title'], [(item['number'], item['label']) for item in frame['options']]]
        fingerprint = hashlib.sha256(json.dumps(identity, ensure_ascii=False).encode()).hexdigest()
        if self.active.get(target) == fingerprint:
            return
        actor = await self.agent(session, pane)
        title = '답변 제출을 기다려요' if frame['kind'] == 'review' else frame['title'].splitlines()[0]
        item = {'id': secrets.token_hex(12), 'created_at': time.time(), 'read': False,
                'host': session['host'], 'host_name': session['host_name'], 'session_id': session['id'],
                'session_name': session['name'], 'pane_id': target, 'pane_title': pane.get('title', ''),
                'agent': actor, 'kind': frame['kind'], 'title': title[:240],
                'body': frame['title'][:1200], 'choices': [item['label'][:160] for item in frame['options'][:8]]}
        self.active[target] = fingerprint
        self.items.insert(0, item)
        self.save()
        if not self.queue.full():
            self.queue.put_nowait(item)

    async def scan(self):
        sessions = await self.fleet.sessions()
        limit = asyncio.Semaphore(4)
        async def inspect(session, pane):
            if session.get('host_status') != '연결됨':
                return
            if pane.get('dead') or not self.candidate(pane):
                await self.observe(session, pane, None)
                return
            async with limit:
                try:
                    frame = await self.fleet.interaction(pane['id'])
                    await self.observe(session, pane, frame)
                except (web.HTTPException, OSError, ValueError):
                    pass  # An unavailable pane must not clear another pane's question.
        await asyncio.gather(*(inspect(session, pane) for session in sessions for pane in session['panes']))
        present = {pane['id'] for session in sessions for pane in session['panes']}
        self.missing = {key: value for key, value in self.missing.items() if key in present}
        removed = set(self.active) - present
        if removed:
            for target in removed:
                self.active.pop(target, None)
            self.save()

    def payload(self, item):
        return {'id': item['id'], 'title': item['agent'] + ' · ' + item['session_name'],
                'body': item['host_name'] + ' — ' + item['title'][:220],
                'url': '/?notification=' + item['id'], 'unread': sum(not item['read'] for item in self.items)}

    async def deliver(self, item, device_ids=None):
        subject = next((origin for origin in self.origins() if origin.startswith('https://')), 'https://tmux-mobile.local')
        limit = asyncio.Semaphore(4)
        async def send(key, value):
            async with limit:
                try:
                    response = await self.sender(subscription_info=value, data=json.dumps(self.payload(item), ensure_ascii=False),
                        vapid_private_key=str(self.key_path), vapid_claims={'sub': subject}, timeout=8, ttl=600,
                        headers={'Urgency': 'high'}, aiohttp_session=self.client)
                    if hasattr(response, 'release'):
                        response.release()
                    self.last_push, self.push_error = time.time(), ''
                    return True
                except WebPushException as error:
                    code = getattr(error, 'status_code', None) or getattr(error.response, 'status', None)
                    if code in {404, 410}:
                        self.devices.pop(key, None)
                    self.push_error = '기기 알림을 전송하지 못했어요. 알림 켜기를 다시 눌러 주세요.'
                except (aiohttp.ClientError, asyncio.TimeoutError, OSError, ValueError):
                    self.push_error = '알림 서비스에 연결하지 못했어요. 접속 중 화면 알림은 계속 표시돼요.'
                return False
        targets = [(key, value) for key, value in list(self.devices.items()) if device_ids is None or key in device_ids]
        results = await asyncio.gather(*(send(key, value) for key, value in targets))
        if targets:
            self.save()
        return bool(results) and all(results)

    async def test(self, key, owner):
        if not isinstance(key, str) or key not in self.devices:
            raise web.HTTPBadRequest(text='먼저 이 기기의 알림을 켜 주세요.')
        now = time.monotonic()
        self.test_times = {token: value for token, value in self.test_times.items() if now - value < 10}
        if owner in self.test_times:
            raise web.HTTPTooManyRequests(text='잠시 뒤에 다시 테스트해 주세요.')
        self.test_times[owner] = now
        item = {'id': 'test-' + secrets.token_hex(6), 'agent': 'Q tmux', 'session_name': '테스트 알림',
                'host_name': '이 기기', 'title': '앞으로 답변이 필요한 질문을 이곳으로 보내요.'}
        if not await self.deliver(item, [key]):
            raise web.HTTPBadGateway(text=self.push_error or '기기 알림을 전송하지 못했어요.')
        return {'ok': True}

    async def run(self):
        while True:
            try:
                await self.scan()
            except Exception:
                LOG.warning('Question notification scan deferred; retrying on the next pass')
            await asyncio.sleep(3)

    async def push(self):
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as client:
            self.client = client
            try:
                while True:
                    item = await self.queue.get()
                    try:
                        await self.deliver(item)
                    except Exception:
                        LOG.warning('Device notification delivery failed; the inbox remains available')
                    finally:
                        self.queue.task_done()
            finally:
                self.client = None
