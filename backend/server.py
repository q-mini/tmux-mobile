"""An authenticated WebSocket bridge to tmux, served on a private Unix socket."""
import argparse
import asyncio
import base64
import contextlib
from dataclasses import dataclass, field
import errno
import fcntl
import hmac
import hashlib
import json
import logging
import os
from pathlib import Path
import pty
import secrets
import shutil
import signal
import socket
import struct
import sys
import termios
import time
from urllib.parse import urlsplit

from aiohttp import web, WSMsgType
from .fleet import FleetWorkspace
from .hosts import load_hosts, save_host
from .ssh_setup import SSHSetup
from .attachments import Attachments
from .notifications import Notifications
from .device_sessions import DeviceSessions, device_id, SESSION
from .navigation_store import NavigationStore
from .file_browser import FileBrowser

ROOT = Path(__file__).resolve().parent.parent
from .q_accounts import Accounts,AccountError
COOKIE = 'tmux_mobile_session'
LOG = logging.getLogger('tmux-mobile')


@dataclass
class Login:
    expires: float
    sockets: set = field(default_factory=set)
    account: bool = False


@dataclass
class Settings:
    port: int = 8765
    state: Path = ROOT / '.state'
    key: str = ''
    ttl: int = 365 * 24 * 3600
    exclude: set = field(default_factory=lambda: {'tmux-mobile'})
    local_origins: set = field(default_factory=set)
    instance: str = field(default_factory=lambda: secrets.token_hex(16))
    watch_questions: bool = True
    accounts_path: Path | None = None

    def origins(self):
        origins = {f'http://127.0.0.1:{self.port}', f'http://localhost:{self.port}'} | self.local_origins
        if os.environ.get('APP_FRONT_ORIGIN'):
            origins.add(os.environ['APP_FRONT_ORIGIN'])
        try:
            value = (self.state / 'public-url').read_text().strip()
            parsed = urlsplit(value)
            if parsed.scheme == 'https' and parsed.netloc and not parsed.path:
                origins.add(value)
        except FileNotFoundError:
            pass
        return origins


SETTINGS = web.AppKey('settings', Settings)
LOGINS = web.AppKey('logins', dict)
ACCOUNTS = web.AppKey('accounts',Accounts)
DEVICES = web.AppKey('devices', DeviceSessions)
FAILURES = web.AppKey('failures', dict)
SOCKETS = web.AppKey('sockets', set)
WORKSPACE = web.AppKey('workspace', FleetWorkspace)
SSH_SETUP = web.AppKey('ssh_setup', SSHSetup)
ATTACHMENTS = web.AppKey('attachments', Attachments)
NOTIFICATIONS = web.AppKey('notifications', Notifications)
NAVIGATION = web.AppKey('navigation', NavigationStore)
FILES = web.AppKey('files', FileBrowser)


def load_key(settings):
    settings.state.mkdir(mode=0o700, parents=True, exist_ok=True)
    settings.state.chmod(0o700)
    key_file = settings.state / 'access-key'
    if not key_file.exists():
        fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(secrets.token_urlsafe(32))
    key_file.chmod(0o600)
    return key_file.read_text().strip()


def authorized(request):
    token=request.cookies.get(COOKIE,'');fingerprint=hashlib.sha256(token.encode()).hexdigest()
    login = request.app[LOGINS].get(fingerprint)
    if token.startswith('qa_'):
        record=request.app[ACCOUNTS].session(token,'tmux')
        if not record:
            request.app[LOGINS].pop(fingerprint,None)
            raise web.HTTPUnauthorized(text='로그인이 필요해요.')
        if login is None:login=Login(time.monotonic()+max(0,record['expires']-time.time()),account=True);request.app[LOGINS][fingerprint]=login
    if login is None or login.expires <= time.monotonic():
        raise web.HTTPUnauthorized(text='로그인이 필요해요.')
    return login


def saved_logins(settings):
    """Keep only hashed session IDs so an app survives a backend restart."""
    try:
        data = json.loads((settings.state / 'logins.json').read_text())
        if data.get('key') != hashlib.sha256(settings.key.encode()).hexdigest():
            return {}
        now, wall = time.monotonic(), time.time()
        return {key: Login(now + min(value - wall, settings.ttl)) for key, value in data['sessions'].items()
                if len(key) == 64 and isinstance(value, (float, int)) and value > wall}
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return {}


def persist_logins(app):
    settings = app[SETTINGS]
    now, wall = time.monotonic(), time.time()
    payload = {'key': hashlib.sha256(settings.key.encode()).hexdigest(),
               'sessions': {key: wall + login.expires - now for key, login in app[LOGINS].items() if login.expires > now and not login.account}}
    temp = settings.state / 'logins.tmp'
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(payload, stream)
    temp.chmod(0o600)
    temp.replace(settings.state / 'logins.json')


@web.middleware
async def security(request, handler):
    origins = request.app[SETTINGS].origins()
    if request.host not in {urlsplit(value).netloc for value in origins}:
        raise web.HTTPForbidden(text='Unknown host')
    if request.method not in {'GET', 'HEAD'} or request.path == '/api/terminal':
        if request.headers.get('Origin') not in origins:
            raise web.HTTPForbidden(text='Origin rejected')
    error = None
    try:
        response = await handler(request)
    except web.HTTPException as exc:
        response = exc
        error = exc
    response.headers.update({
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    })
    if response.content_type.startswith('image/'):
        response.headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'"
    if error is not None:
        raise error
    return response


async def login(request):
    settings = request.app[SETTINGS]
    try:
        data = await request.json()
    except (ValueError, UnicodeError):
        raise web.HTTPBadRequest(text='Invalid JSON')
    if not isinstance(data, dict) or type(data.get('remember', False)) is not bool:
        raise web.HTTPBadRequest(text='Invalid login preference')
    # The bridge binds only to loopback; Cloudflare supplies the external client IP.
    peer = request.headers.get('CF-Connecting-IP', request.remote or 'local')
    now = time.monotonic()
    current_token = request.cookies.get(COOKIE, '')
    current = request.app[LOGINS].get(hashlib.sha256(current_token.encode()).hexdigest())
    if current and current.expires > now and not current.account:
        credential = request.app[DEVICES].bind(current_token, data.get('device_id'), request.headers.get('User-Agent', ''), data.get('remember', False))
        digest = hashlib.sha256(credential.encode()).hexdigest()
        request.app[LOGINS].pop(hashlib.sha256(current_token.encode()).hexdigest(), None)
        request.app[LOGINS][digest] = current
        current.expires = now + (settings.ttl if data.get('remember', False) else min(SESSION, settings.ttl))
        persist_logins(request.app)
        return login_response(request, credential, reused=True)
    failures = request.app[FAILURES]
    for address in list(failures):
        failures[address] = [stamp for stamp in failures[address] if stamp > now - 60]
        if not failures[address]:
            del failures[address]
    attempts = failures.get(peer, [])
    if len(attempts) >= 5:
        raise web.HTTPTooManyRequests(text='1분 뒤에 다시 시도해 주세요.')
    key = data.get('key') if isinstance(data, dict) else None
    if not isinstance(key, str) or not hmac.compare_digest(key.encode(), settings.key.encode()):
        failures.setdefault(peer, []).append(now)
        raise web.HTTPUnauthorized(text='접속 키가 맞지 않아요.')
    failures.pop(peer, None)
    logins = request.app[LOGINS]
    for token in list(logins):
        if logins[token].expires <= now:
            del logins[token]
    identifier = device_id(data.get('device_id'))
    previous = request.app[DEVICES].fingerprint(identifier)
    if previous:
        replaced = logins.pop(previous, None)
        if replaced:
            for socket in list(replaced.sockets):
                await socket.close(code=1000, message=b'Device signed in again')
    if len(logins) >= 128:
        raise web.HTTPTooManyRequests(text='Too many active logins')
    remember = data.get('remember', False)
    token = request.app[DEVICES].bind('', identifier, request.headers.get('User-Agent', ''), remember)
    digest = hashlib.sha256(token.encode()).hexdigest()
    lifetime = settings.ttl if remember else min(SESSION, settings.ttl)
    if digest not in logins:
        logins[digest] = Login(now + lifetime)
    else:
        logins[digest].expires = now + lifetime
    persist_logins(request.app)
    return login_response(request, token)


async def account_request(request):
    if request.method=='POST' and request.content_length and request.content_length>16384:raise web.HTTPRequestEntityTooLarge(max_size=16384,actual_size=request.content_length)
    try:
        body=await request.json() if request.method=='POST' else {}
        bootstrap=False
        if isinstance(body,dict) and body.get('action') in {'register','login'}:
            try:bootstrap=not authorized(request).account
            except web.HTTPUnauthorized:pass
        value,credential,clear=await asyncio.to_thread(request.app[ACCOUNTS].handle,request.method,body,request.cookies.get(COOKIE,''),'tmux',request.app[SETTINGS].key,request.headers.get('CF-Connecting-IP',request.remote or 'local'),request.headers.get('User-Agent',''),bootstrap=bootstrap)
    except AccountError as error:return web.json_response({'error':str(error)},status=error.status)
    except (ValueError,TypeError):raise web.HTTPBadRequest(text='잘못된 요청이에요.')
    response=login_response(request,credential) if credential else web.json_response(value)
    if credential:response.text=json.dumps(value,ensure_ascii=False)
    if clear:response.del_cookie(COOKIE,path='/')
    return response


def login_response(request, token, reused=False):
    settings = request.app[SETTINGS]
    account=request.app[ACCOUNTS].session(token,'tmux')
    remember = bool(account['remember']) if account else request.app[DEVICES].remembered(token)
    response = web.json_response({'ok': True, 'reused': reused, 'remember': remember})
    secure = request.host not in {f'127.0.0.1:{settings.port}', f'localhost:{settings.port}'}
    # Test servers may use a dynamically allocated loopback port.
    if f'http://{request.host}' in settings.local_origins | {os.environ.get('APP_FRONT_ORIGIN', '')}:
        secure = False
    response.set_cookie(COOKIE, token, httponly=True, secure=secure, samesite='Strict', max_age=settings.ttl if remember else None, path='/')
    return response


async def logout(request):
    token=request.cookies.get(COOKIE,'')
    if token.startswith('qa_') and request.app[ACCOUNTS].session(token,'tmux'):
        await asyncio.to_thread(request.app[ACCOUNTS].handle,'POST',{'action':'logout'},token,'tmux',request.app[SETTINGS].key,'local','')
    for item in request.app[DEVICES].list(request.cookies.get(COOKIE, '')):
        if item['current']:
            request.app[DEVICES].revoke(item['id'])
    current = request.app[LOGINS].pop(hashlib.sha256(request.cookies.get(COOKIE, '').encode()).hexdigest(), None)
    persist_logins(request.app)
    if current:
        for socket in list(current.sockets):
            await socket.close(code=1000, message=b'Logged out')
    response = web.json_response({'ok': True})
    response.del_cookie(COOKIE, path='/')
    return response


async def bind_browser(request):
    current = authorized(request)
    data = await request.json()
    old_token = request.cookies.get(COOKIE, '')
    if old_token.startswith('qa_'):
        try:await asyncio.to_thread(request.app[ACCOUNTS].bind,old_token,'tmux',data.get('remember'))
        except AccountError as error:raise web.HTTPBadRequest(text=str(error))
        record=request.app[ACCOUNTS].session(old_token,'tmux');current.expires=time.monotonic()+max(0,record['expires']-time.time())
        return login_response(request,old_token,reused=True)
    try:
        token = request.app[DEVICES].bind(old_token, data.get('device_id'), request.headers.get('User-Agent', ''), data.get('remember'))
    except ValueError as error:
        raise web.HTTPBadRequest(text=str(error))
    old_digest, digest = (hashlib.sha256(value.encode()).hexdigest() for value in (old_token, token))
    request.app[LOGINS].pop(old_digest, None)
    request.app[LOGINS][digest] = current
    lifetime = request.app[SETTINGS].ttl
    current.expires = time.monotonic() + (lifetime if request.app[DEVICES].remembered(token) else min(lifetime, SESSION))
    persist_logins(request.app)
    return login_response(request, token, reused=True)


async def devices_list(request):
    authorized(request)
    if request.cookies.get(COOKIE,'').startswith('qa_'):return web.json_response({'devices':request.app[ACCOUNTS].devices(request.cookies[COOKIE],'tmux')})
    return web.json_response({'devices': request.app[DEVICES].list(request.cookies.get(COOKIE, ''))})


async def devices_revoke(request):
    authorized(request)
    data = await request.json()
    if not isinstance(data, dict):
        raise web.HTTPBadRequest()
    if request.cookies.get(COOKIE,'').startswith('qa_'):
        try:result=await asyncio.to_thread(request.app[ACCOUNTS].revoke,request.cookies[COOKIE],data,'tmux')
        except AccountError as error:raise web.HTTPBadRequest(text=str(error))
        response=web.json_response(result)
        if result['current']:response.del_cookie(COOKIE,path='/')
        return response
    if data.get('all') is True:
        count = request.app[DEVICES].revoke_all()
        logins = list(request.app[LOGINS].values())
        request.app[LOGINS].clear()
        persist_logins(request.app)
        for login in logins:
            for socket in list(login.sockets):
                await socket.close(code=1000, message=b'All devices disconnected')
        response = web.json_response({'ok': True, 'current': True, 'removed': count})
        response.del_cookie(COOKIE, path='/')
        return response
    if 'ids' in data:
        try:
            removed = request.app[DEVICES].revoke_many(data['ids'])
        except ValueError as error:
            raise web.HTTPBadRequest(text=str(error))
        except KeyError:
            raise web.HTTPNotFound()
        own_digest = hashlib.sha256(request.cookies.get(COOKIE, '').encode()).hexdigest()
        for digest in removed.values():
            login = request.app[LOGINS].pop(digest, None)
            if login:
                for socket in list(login.sockets):
                    await socket.close(code=1000, message=b'Device disconnected')
        persist_logins(request.app)
        current = own_digest in removed.values()
        response = web.json_response({'ok': True, 'current': current, 'removed': len(removed)})
        if current:
            response.del_cookie(COOKIE, path='/')
        return response
    identifier = data.get('id')
    if not isinstance(identifier, str) or not any(item['id'] == identifier for item in request.app[DEVICES].list(request.cookies.get(COOKIE, ''))):
        raise web.HTTPNotFound()
    digest = request.app[DEVICES].fingerprint(identifier)
    is_current = hmac.compare_digest(digest, hashlib.sha256(request.cookies.get(COOKIE, '').encode()).hexdigest())
    request.app[DEVICES].revoke(identifier)
    current = request.app[LOGINS].pop(digest, None)
    persist_logins(request.app)
    if current:
        for socket in list(current.sockets):
            await socket.close(code=1000, message=b'Device disconnected')
    return web.json_response({'ok': True, 'current': is_current})


async def tmux_sessions(settings):
    proc = await asyncio.create_subprocess_exec('tmux', 'list-sessions', '-F', '#{session_id}\t#{session_name}\t#{session_windows}\t#{session_attached}', stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    stdout, stderr = await proc.communicate()
    if proc.returncode:
        if b'no server running' in stderr or b'no sessions' in stderr or b'error connecting' in stderr:
            return []
        raise RuntimeError('tmux list-sessions failed')
    sessions = []
    for line in stdout.decode().splitlines():
        sid, rest = line.split('\t', 1)
        name, windows, attached = rest.rsplit('\t', 2)
        if name not in settings.exclude:
            sessions.append({'id': sid, 'name': name, 'windows': int(windows), 'attached': int(attached)})
    return sessions


async def sessions(request):
    authorized(request)
    workspace = request.app[WORKSPACE]
    if isinstance(workspace, FleetWorkspace):
        workspace.configure(load_hosts(request.app[SETTINGS].state))
    items = await workspace.sessions(fresh=request.query.get('refresh') == '1')
    return web.json_response({'sessions': items, 'hosts': workspace.host_info()})


async def session_create(request):
    authorized(request)
    try:
        data = await request.json()
    except (ValueError, UnicodeError):
        raise web.HTTPBadRequest(text='잘못된 세션 생성 요청이에요.')
    if not isinstance(data, dict):
        raise web.HTTPBadRequest(text='잘못된 세션 생성 요청이에요.')
    session = await request.app[WORKSPACE].create_session(data.get('host'), data.get('name'), data.get('path', ''))
    return web.json_response({'session': session}, status=201)


async def session_manage(request):
    authorized(request)
    try:
        data = await request.json()
    except (ValueError, UnicodeError):
        raise web.HTTPBadRequest(text='잘못된 요청이에요.')
    if not isinstance(data, dict) or data.get('action') not in {'rename', 'delete'}:
        raise web.HTTPBadRequest(text='세션 작업을 선택해 주세요.')
    return web.json_response(await request.app[WORKSPACE].manage_session(request.match_info['session'], data['action'], data.get('name')))


async def host_manage(request):
    authorized(request)
    try:
        data = await request.json()
        if not isinstance(data, dict) or data.get('action') not in {'add', 'edit', 'remove'}:
            raise ValueError('서버 작업을 선택해 주세요.')
        host = save_host(request.app[SETTINGS].state, data['action'], data)
    except (ValueError, TypeError) as error:
        raise web.HTTPBadRequest(text=str(error))
    request.app[WORKSPACE].configure(load_hosts(request.app[SETTINGS].state))
    return web.json_response({'ok': True, 'host': host.id})


async def host_key(request):
    authorized(request)
    return web.json_response(await request.app[SSH_SETUP].probe(request.match_info['host']))


async def pane_snapshot(request):
    authorized(request)
    try:
        history = int(request.query.get('history', '800'))
    except ValueError:
        raise web.HTTPBadRequest(text='잘못된 이전 출력 범위예요.')
    return web.json_response(await request.app[WORKSPACE].snapshot(request.match_info['pane'], request.query.get('version', ''),
                                                                 history=history, grid=request.query.get('grid') == '1'))


async def pane_conversation(request):
    authorized(request)
    before, known = request.query.get('before', ''), request.query.get('version', '')
    if len(before) > 150 or len(known) > 100:
        raise web.HTTPBadRequest(text='잘못된 대화 기록 위치예요.')
    return web.json_response(await request.app[WORKSPACE].conversation(request.match_info['pane'], before, known))


async def pane_media(request):
    authorized(request)
    ref = request.query.get('ref', '')
    if len(ref) > 180 or not ref:
        raise web.HTTPBadRequest(text='잘못된 이미지 위치예요.')
    result = await request.app[WORKSPACE].media(request.match_info['pane'], ref)
    return web.Response(body=base64.b64decode(result['data'], validate=True), content_type=result['mime'],
                        headers={'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'"})


async def pane_interaction(request):
    authorized(request)
    return web.json_response({'interaction': await request.app[WORKSPACE].interaction(request.match_info['pane'], grid=True) if request.query.get('grid') == '1' else await request.app[WORKSPACE].interaction(request.match_info['pane'])})


async def pane_pending_input(request):
    authorized(request)
    frame = await request.app[WORKSPACE].pending_input(request.match_info['pane'])
    return web.json_response({'pending': {key: value for key, value in frame.items() if key not in {'keys', 'hint'}} if frame else None})


async def notifications_list(request):
    authorized(request)
    return web.json_response(request.app[NOTIFICATIONS].listing(request.query.get('version', '')[:100]))


async def notification_payload(request):
    authorized(request)
    try:
        payload = await request.json()
    except (ValueError, UnicodeError):
        raise web.HTTPBadRequest(text='잘못된 알림 요청이에요.')
    if not isinstance(payload, dict):
        raise web.HTTPBadRequest(text='잘못된 알림 요청이에요.')
    return payload


async def notifications_read(request):
    payload = await notification_payload(request)
    return web.json_response(request.app[NOTIFICATIONS].read(payload.get('ids')))


async def notifications_subscribe(request):
    payload = await notification_payload(request)
    return web.json_response(request.app[NOTIFICATIONS].subscribe(payload.get('subscription')))


async def notifications_unsubscribe(request):
    authorized(request)
    return web.json_response(request.app[NOTIFICATIONS].unsubscribe(request.match_info['device']))


async def notifications_test(request):
    payload = await notification_payload(request)
    return web.json_response(await request.app[NOTIFICATIONS].test(payload.get('id'), request.cookies[COOKIE]))


async def notification_lifecycle(app):
    if not app[SETTINGS].watch_questions:
        yield
        return
    hub = app[NOTIFICATIONS]
    tasks = [asyncio.create_task(hub.run()), asyncio.create_task(hub.push())]
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task


async def host_connect(request):
    authorized(request)
    try:
        payload = await request.json()
    except (ValueError, UnicodeError):
        raise web.HTTPBadRequest(text='잘못된 요청이에요.')
    if not isinstance(payload, dict):
        raise web.HTTPBadRequest(text='잘못된 요청이에요.')
    return web.json_response(await request.app[SSH_SETUP].connect(request.match_info['host'], payload.get('password'), payload.get('trust', '')))


async def pane_input(request):
    authorized(request)
    try:
        payload = await request.json()
    except (ValueError, UnicodeError):
        raise web.HTTPBadRequest(text='Invalid JSON')
    if not isinstance(payload, dict):
        raise web.HTTPBadRequest(text='잘못된 입력이에요.')
    payload = request.app[ATTACHMENTS].message(request.match_info['pane'], payload, request.cookies[COOKIE])
    result = await request.app[WORKSPACE].send(request.match_info['pane'], payload, request.cookies[COOKIE])
    if result.get('ok'):
        request.app[ATTACHMENTS].mark_sent(payload.get('attachments', []))
    return web.json_response(result)


async def pane_catalog(request):
    authorized(request)
    return web.json_response(await request.app[WORKSPACE].catalog(request.match_info['pane']))


async def pane_agent_state(request):
    authorized(request)
    return web.json_response(await request.app[WORKSPACE].agent_state(request.match_info['pane']))


async def attachment_upload(request):
    authorized(request)
    return web.json_response(await request.app[ATTACHMENTS].upload(request, request.match_info['pane'], request.cookies[COOKIE]))


async def attachment_delete(request):
    authorized(request)
    await request.app[ATTACHMENTS].remove(request.match_info['attachment'], request.cookies[COOKIE])
    return web.json_response({'ok': True})


async def attachment_preview(request):
    authorized(request)
    return await request.app[ATTACHMENTS].preview(request.match_info['attachment'])


async def attachment_lifecycle(app):
    async def clean():
        while True:
            try:
                await app[ATTACHMENTS].sweep()
            except Exception:
                LOG.warning('Temporary attachment cleanup deferred; retrying on the next pass')
            await asyncio.sleep(300)
    task = asyncio.create_task(clean())
    yield
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


def dimensions(cols, rows):
    if type(cols) is not int or type(rows) is not int:
        raise ValueError('Terminal dimensions must be integers')
    if not (20 <= cols <= 500 and 5 <= rows <= 200):
        raise ValueError('Terminal dimensions out of range')
    return cols, rows


async def terminal(request):
    current = authorized(request)
    if len(current.sockets) >= 3 or len(request.app[SOCKETS]) >= 8:
        raise web.HTTPTooManyRequests(text='Too many terminals')
    sid = request.query.get('session', '')
    sizing = request.query.get('sizing', 'mirror')
    if sizing not in {'mirror', 'window'}:
        raise web.HTTPBadRequest(text='Invalid terminal sizing')
    try:
        cols, rows = dimensions(int(request.query.get('cols', '100')), int(request.query.get('rows', '30')))
    except ValueError:
        raise web.HTTPBadRequest(text='Invalid terminal size')
    request.app[WORKSPACE].resolve(sid, '$')
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=65536)
    await ws.prepare(request)
    current.sockets.add(ws)
    request.app[SOCKETS].add(ws)
    try:
        host, raw_sid, sizing = await request.app[WORKSPACE].terminal(sid, sizing)
    except web.HTTPException as error:
        # WebSocket handshakes hide HTTP error bodies from browsers. Report
        # preparation errors on the socket so a failed attach is not a spinner.
        try:
            await ws.send_json({'type': 'error', 'message': error.text, 'status': error.status})
        finally:
            current.sockets.discard(ws)
            request.app[SOCKETS].discard(ws)
            await ws.close(code=1008)
        return ws
    except BaseException:
        current.sockets.discard(ws)
        request.app[SOCKETS].discard(ws)
        await ws.close(code=1011)
        raise
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    try:
        child = await asyncio.create_subprocess_exec(sys.executable, '-m', 'backend.helpers.tmux_client', str(slave), raw_sid, sizing, host.id, str(request.app[SETTINGS].state), pass_fds=(slave,))
    except Exception:
        os.close(master)
        current.sockets.discard(ws)
        request.app[SOCKETS].discard(ws)
        await ws.close(code=1011, message=b'Could not start tmux client')
        raise
    finally:
        os.close(slave)
    os.set_blocking(master, False)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    loop = asyncio.get_running_loop()
    output = asyncio.Queue(maxsize=64)
    paused = False
    reader_open = True

    def read_ready():
        nonlocal paused, reader_open
        try:
            chunk = os.read(master, 32768)
        except BlockingIOError:
            return
        except OSError:
            chunk = b''
        if not chunk:
            loop.remove_reader(master)
            reader_open = False
            # Leave queued terminal output available before reporting EOF.
            if not output.full():
                output.put_nowait(None)
            else:
                loop.create_task(ws.close())
            return
        output.put_nowait(chunk)
        if output.full():
            loop.remove_reader(master)
            paused = True

    async def send_output():
        nonlocal paused
        while True:
            chunk = await output.get()
            if paused and reader_open:
                loop.add_reader(master, read_ready)
                paused = False
            if chunk is None:
                await ws.close(code=1000, message=b'Tmux client disconnected')
                return
            await ws.send_bytes(chunk)

    async def expire():
        while current.expires>time.monotonic():
            await asyncio.sleep(min(5,max(0,current.expires-time.monotonic())))
            if current.account and not await asyncio.to_thread(request.app[ACCOUNTS].session,request.cookies.get(COOKIE,''),'tmux'):break
        await ws.close(code=1008, message=b'Login expired')

    async def write_input(data):
        remaining = memoryview(data)
        while remaining:
            try:
                remaining = remaining[os.write(master, remaining):]
            except BlockingIOError:
                ready = loop.create_future()
                loop.add_writer(master, lambda: ready.done() or ready.set_result(None))
                try:
                    await ready
                finally:
                    loop.remove_writer(master)

    loop.add_reader(master, read_ready)
    sender = asyncio.create_task(send_output())
    expiry = asyncio.create_task(expire())
    # Operational display metadata only; never log pairing keys or terminal input.
    agent = request.headers.get('User-Agent', '').replace('\n', ' ')[:220]
    details = {name: request.query.get(name, 'legacy')[:40] for name in ['build', 'viewport', 'pointer']}
    LOG.info('Terminal attached to %s sizing=%s grid=%sx%s view=%r agent=%r', sid, sizing, cols, rows, details, agent)
    try:
        async for message in ws:
            try:authorized(request)
            except web.HTTPUnauthorized:
                await ws.close(code=1008,message=b'Login expired');break
            if message.type != WSMsgType.TEXT:
                if message.type in {WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.ERROR}:
                    break
                await ws.close(code=1008, message=b'JSON messages required')
                break
            try:
                data = json.loads(message.data)
                if not isinstance(data, dict):
                    raise ValueError('Expected an object')
                if data.get('type') == 'input' and isinstance(data.get('data'), str):
                    binary = data.get('binary', False)
                    if type(binary) is not bool:
                        raise ValueError('Invalid binary flag')
                    await write_input(data['data'].encode('latin-1' if binary else 'utf-8'))
                elif data.get('type') == 'resize':
                    cols, rows = dimensions(data.get('cols'), data.get('rows'))
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                else:
                    raise ValueError('Unknown message')
            except (ValueError, TypeError, OSError):
                await ws.close(code=1008, message=b'Invalid terminal message')
                break
    finally:
        loop.remove_reader(master)
        loop.remove_writer(master)
        sender.cancel()
        expiry.cancel()
        for task in [sender, expiry]:
            with contextlib.suppress(asyncio.CancelledError, ConnectionError):
                await task
        os.close(master)
        if child.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                child.terminate()
        try:
            await asyncio.wait_for(child.wait(), timeout=0.5)
        except asyncio.TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                child.kill()
            await child.wait()
        current.sockets.discard(ws)
        request.app[SOCKETS].discard(ws)
        LOG.info('Terminal detached from %s; tmux session preserved', sid)
    return ws


async def shutdown(app):
    await app[FILES].close()
    for socket in list(app[SOCKETS]):
        await socket.close(code=1001, message=b'Server shutdown')


async def home(request):
    return web.FileResponse(ROOT / 'web/workspace.html')


async def launcher(request):
    return web.FileResponse(ROOT / 'web/launcher.html')


async def session_status(request):
    authorized(request)
    return web.json_response({'ok': True})


async def service_worker(request):
    return web.FileResponse(ROOT / 'web/js/sw.js', headers={'Service-Worker-Allowed': '/', 'Cache-Control': 'no-cache'})


async def health(request):
    return web.json_response({'ok': True, 'app': 'tmux-mobile', 'instance': request.app[SETTINGS].instance})


async def navigation_get(request):
    authorized(request)
    return web.json_response(request.app[NAVIGATION].snapshot())


async def files_get(request):
    authorized(request)
    try:
        offset = int(request.query.get('offset', '0'))
    except ValueError:
        raise web.HTTPBadRequest(text='폴더 페이지를 확인해 주세요.')
    result = await request.app[FILES].read(request.query.get('host', ''), request.query.get('path', ''),
        request.query.get('mode', 'list'), request.query.get('hidden') == '1', offset,
        request.query.get('refresh') == '1')
    if request.query.get('mode') == 'download':
        from urllib.parse import quote
        return web.Response(body=base64.b64decode(result['data']), content_type='application/octet-stream',
            headers={'Content-Disposition': "attachment; filename*=UTF-8''" + quote(result['name'], safe=''),
                     'X-Content-Type-Options': 'nosniff'})
    return web.json_response(result)


async def files_post(request):
    authorized(request)
    try:body = await request.clone(client_max_size=2*1024*1024).json()
    except (ValueError, UnicodeError):raise web.HTTPBadRequest(text='파일 작업을 확인해 주세요.')
    if not isinstance(body, dict):raise web.HTTPBadRequest(text='파일 작업을 확인해 주세요.')
    return web.json_response(await request.app[FILES].mutate(body.get('host'), body))


async def files_upload(request):
    authorized(request)
    return web.json_response(await request.app[FILES].upload(request))


async def file_settings(request):
    authorized(request)
    files = request.app[FILES]
    host = request.query.get('server') or files.workspace.local.id
    body = await request.json() if request.method == 'POST' else {}
    if not isinstance(body, dict):raise web.HTTPBadRequest(text='휴지통 경로를 확인해 주세요.')
    return web.json_response(await files.mutate(host, {**body, 'action': 'settings-save' if request.method == 'POST' else 'settings'}))


async def navigation_update(request):
    authorized(request)
    try:
        payload = await request.json()
        return web.json_response(request.app[NAVIGATION].apply(payload, request.app[WORKSPACE].backends))
    except (ValueError, TypeError, UnicodeError) as error:
        raise web.HTTPBadRequest(text=str(error))


def make_app(settings=None):
    settings = settings or Settings()
    if not settings.key:
        settings.key = load_key(settings)
    app = web.Application(middlewares=[security], client_max_size=65536)
    app[SETTINGS] = settings
    app[LOGINS] = saved_logins(settings)
    app[ACCOUNTS] = Accounts(settings.accounts_path or settings.state / 'accounts.sqlite3')
    app[DEVICES] = DeviceSessions(settings.state / 'devices.json', lambda: settings.key)
    app[FAILURES] = {}
    app[SOCKETS] = set()
    app[WORKSPACE] = FleetWorkspace(load_hosts(settings.state), settings.exclude)
    app[FILES] = FileBrowser(app[WORKSPACE])
    app[SSH_SETUP] = SSHSetup(settings.state, app[WORKSPACE])
    app[ATTACHMENTS] = Attachments(settings.state, app[WORKSPACE])
    app[NOTIFICATIONS] = Notifications(settings.state, app[WORKSPACE], settings.origins)
    app[NAVIGATION] = NavigationStore(settings.state / 'navigation.json')
    app.router.add_get('/', home)
    app.router.add_get('/app', launcher)
    app.router.add_get('/api/session', session_status)
    app.router.add_get('/healthz', health)
    app.router.add_get('/sw.js', service_worker)
    app.router.add_post('/api/login', login)
    app.router.add_get('/api/account',account_request)
    app.router.add_post('/api/account',account_request)
    app.router.add_post('/api/logout', logout)
    app.router.add_post('/api/device', bind_browser)
    app.router.add_get('/api/devices', devices_list)
    app.router.add_post('/api/devices', devices_revoke)
    app.router.add_get('/api/navigation', navigation_get)
    app.router.add_get('/api/files', files_get)
    app.router.add_post('/api/files', files_post)
    app.router.add_post('/api/files/upload', files_upload)
    app.router.add_get('/api/settings', file_settings)
    app.router.add_post('/api/settings', file_settings)
    app.router.add_post('/api/navigation', navigation_update)
    app.router.add_get('/api/sessions', sessions)
    app.router.add_post('/api/sessions', session_create)
    app.router.add_post('/api/sessions/{session}/manage', session_manage)
    app.router.add_post('/api/hosts', host_manage)
    app.router.add_get('/api/hosts/{host}/key', host_key)
    app.router.add_get('/api/notifications', notifications_list)
    app.router.add_post('/api/notifications/read', notifications_read)
    app.router.add_post('/api/notifications/subscriptions', notifications_subscribe)
    app.router.add_delete('/api/notifications/subscriptions/{device}', notifications_unsubscribe)
    app.router.add_post('/api/notifications/test', notifications_test)
    app.router.add_post('/api/hosts/{host}/connect', host_connect)
    app.router.add_get('/api/panes/{pane}/snapshot', pane_snapshot)
    app.router.add_get('/api/panes/{pane}/conversation', pane_conversation)
    app.router.add_get('/api/panes/{pane}/media', pane_media)
    app.router.add_get('/api/panes/{pane}/interaction', pane_interaction)
    app.router.add_get('/api/panes/{pane}/catalog', pane_catalog)
    app.router.add_get('/api/panes/{pane}/agent-state',pane_agent_state)
    app.router.add_get('/api/panes/{pane}/pending-input', pane_pending_input)
    app.router.add_post('/api/panes/{pane}/input', pane_input)
    app.router.add_post('/api/panes/{pane}/attachments', attachment_upload)
    app.router.add_delete('/api/attachments/{attachment}', attachment_delete)
    app.router.add_get('/api/attachments/{attachment}/preview', attachment_preview)
    app.router.add_get('/api/terminal', terminal)
    app.router.add_static('/static/', ROOT / 'web', show_index=False)
    app.on_shutdown.append(shutdown)
    app.cleanup_ctx.append(attachment_lifecycle)
    app.cleanup_ctx.append(notification_lifecycle)
    return app


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--resume-origin', action='store_true', help='Reuse this service\'s saved listener and identity during a controlled restart')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    settings = Settings(port=args.port)
    # Hide this installation's own service session, whatever name it was started with.
    try:
        settings.exclude = {json.loads((settings.state / 'service.json').read_text())['session']}
    except (OSError, ValueError, KeyError, TypeError):
        pass
    resume_port = 0
    if args.resume_origin:
        saved = urlsplit((settings.state / 'listen-url').read_text().strip())
        instance = (settings.state / 'instance-id').read_text().strip()
        if saved.scheme != 'http' or saved.hostname != '127.0.0.1' or not saved.port or saved.path or len(instance) != 32 or any(char not in '0123456789abcdef' for char in instance):
            raise SystemExit('Invalid saved origin metadata')
        resume_port = saved.port
        settings.instance = instance
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(('127.0.0.1', int(os.environ.get('APP_BACKEND_PORT', resume_port))))
    listener.listen(128)
    settings.port = listener.getsockname()[1]
    app = make_app(settings)
    instance_lock = open(settings.state / 'server.lock', 'a+')
    try:
        fcntl.flock(instance_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('tmux mobile is already running')
    (settings.state / 'instance-id').write_text(settings.instance)
    (settings.state / 'server.pid').write_text(str(os.getpid()))
    if not os.environ.get('APP_BACKEND_PORT'):
        (settings.state / 'listen-url').write_text(f'http://127.0.0.1:{settings.port}')
    LOG.info('Access key stored in %s (not logged)', settings.state / 'access-key')
    web.run_app(app, sock=listener, path=str(settings.state / 'app.sock'), access_log=None)


if __name__ == '__main__':
    main()
