"""Combine host inventories without mixing tmux IDs, inputs or unavailable hosts."""
import asyncio
import re
import time

from aiohttp import web
from .workspace import Workspace
from .claude_history import read_conversation
from urllib.parse import quote


class FleetWorkspace:
    def __init__(self, hosts, excluded):
        self.hosts = {host.id: host for host in hosts}
        self.local = next(host for host in hosts if host.local)
        self.backends = {host.id: Workspace(excluded, None if host.local else host.command, None if host.local else host.conversation, None if host.local else host.agent, None if host.local else host.catalog) for host in hosts}
        self.last = {host.id: [] for host in hosts}
        self.statuses = {host.id: '확인 중' for host in hosts}
        self.refreshed = {host.id: 0 for host in hosts}
        self.lock = asyncio.Lock()
        self.input_routes = {}

    def qualify(self, host, value):
        return value if host.local else host.id + '~' + value

    def resolve(self, value, prefix):
        if not isinstance(value, str):
            raise web.HTTPNotFound(text='작업을 찾을 수 없어요.')
        host = self.local
        if '~' in value:
            name, value = value.split('~', 1)
            host = self.hosts.get(name)
        if host is None or not re.fullmatch(re.escape(prefix) + r'\d+', value):
            raise web.HTTPNotFound(text='작업을 찾을 수 없어요.')
        return host, value

    def pane_info(self, host, pane):
        return {**pane, 'id': self.qualify(host, pane['id']),
                'session_id': self.qualify(host, pane['session_id']), 'host': host.id}

    def session_info(self, host, session):
        return {**session, 'id': self.qualify(host, session['id']), 'host': host.id,
                'host_name': host.name, 'host_address': host.address, 'host_local': host.local,
                'host_status': self.statuses[host.id],
                'panes': [self.pane_info(host, pane) for pane in session['panes']]}

    async def sessions(self, fresh=False):
        async with self.lock:
            async def update(host):
                now = time.monotonic()
                if not fresh and now - self.refreshed[host.id] < (.7 if self.statuses[host.id] == '연결됨' else 5):
                    return
                try:
                    self.last[host.id] = await self.backends[host.id].sessions(fresh=fresh)
                    self.statuses[host.id] = '연결됨'
                except web.HTTPException as error:
                    self.statuses[host.id] = error.text
                self.refreshed[host.id] = time.monotonic()
            await asyncio.gather(*(update(host) for host in self.hosts.values()))
            return [self.session_info(host, session) for host in self.hosts.values() for session in self.last[host.id]]

    def host_info(self):
        return [{'id': host.id, 'name': host.name, 'address': host.address, 'user': host.user, 'local': host.local,
                 'status': self.statuses[host.id], 'connected': self.statuses[host.id] == '연결됨',
                 'port': host.port, 'platform': host.platform, 'verify_key': bool(host.known_hosts_file),
                 'sessions': len(self.last[host.id])} for host in self.hosts.values()]

    def configure(self, hosts):
        for host in hosts:
            if self.hosts.get(host.id) == host:
                continue
            if host.id in self.backends:
                backend=self.backends[host.id]
                backend.runner=None if host.local else host.command
                backend.transcript_runner=None if host.local else host.conversation
                backend.agent_runner=None if host.local else host.agent
                backend.catalog_runner=None if host.local else host.catalog
                backend.catalog_cache.clear()
                backend.inventory_cache=(0,[])
            else:
                self.backends[host.id] = Workspace(self.backends[self.local.id].excluded, None if host.local else host.command,
                    None if host.local else host.conversation, None if host.local else host.agent, None if host.local else host.catalog)
            self.last[host.id] = self.last.get(host.id, [])
            self.statuses[host.id] = '확인 중'
            self.refreshed[host.id] = 0
        self.hosts = {host.id: host for host in hosts}
        self.local = next(host for host in hosts if host.local)
        for mapping in (self.backends, self.last, self.statuses, self.refreshed):
            for key in set(mapping) - set(self.hosts):
                del mapping[key]

    async def manage_session(self, sid, action, name=None):
        host, raw = self.resolve(sid, '$')
        await self.backends[host.id].manage_session(raw, action, name)
        self.refreshed[host.id] = 0
        return {'ok': True}

    async def create_session(self, host_id, name, path=''):
        host = self.hosts.get(host_id) if isinstance(host_id, str) else None
        if host is None:
            raise web.HTTPBadRequest(text='설정된 서버를 선택해 주세요.')
        session = await self.backends[host.id].create_session(name, path)
        self.last[host.id] = await self.backends[host.id].sessions(fresh=True)
        self.statuses[host.id] = '연결됨'
        self.refreshed[host.id] = time.monotonic()
        return self.session_info(host, session)

    async def snapshot(self, pid, known='', **options):
        host, raw = self.resolve(pid, '%')
        result = await self.backends[host.id].snapshot(raw, known, **options)
        return {**result, 'pane': self.pane_info(host, result['pane'])}

    async def conversation(self, pid, before='', known=''):
        host, raw = self.resolve(pid, '%')
        result = await self.backends[host.id].conversation(raw, before, known)
        for item in result.get('messages', []):
            for media in item.get('media', []):
                media['url'] = '/api/panes/' + quote(pid, safe='') + '/media?ref=' + quote(media['ref'], safe='')
        return result

    async def media(self, pid, ref):
        host, raw = self.resolve(pid, '%')
        pane = await self.backends[host.id].pane(raw)
        if ref.startswith('codex:'):
            output, _, _ = await self.backends[host.id].command('capture-pane', '-p', '-J', '-t', raw, '-S', '-800')
            pane = dict(pane, screen=output.decode('utf-8', errors='replace'))
        try:
            result = await asyncio.to_thread(read_conversation, pane, media=ref) if host.local else await host.conversation(pane, media=ref)
        except (ValueError, OSError):
            raise web.HTTPGone(text='원본 이미지가 없거나 대화 세션이 바뀌었어요.')
        if result.get('media_error'):
            raise web.HTTPGone(text=result['media_error'])
        return result

    async def interaction(self, pid, grid=False):
        host, raw = self.resolve(pid, '%')
        return await self.backends[host.id].interaction(raw, grid=True) if grid else await self.backends[host.id].interaction(raw)

    async def catalog(self, pid):
        host, raw = self.resolve(pid, '%')
        return await self.backends[host.id].catalog(raw)

    async def agent_state(self,pid):
        host,raw=self.resolve(pid,'%')
        return await self.backends[host.id].agent_state(raw)

    async def pending_input(self, pid):
        host, raw = self.resolve(pid, '%')
        return await self.backends[host.id].pending_input(raw)

    async def send(self, pid, payload, owner):
        host, raw = self.resolve(pid, '%')
        if isinstance(payload, dict) and isinstance(payload.get('request_id'), str):
            now = time.monotonic()
            self.input_routes = {key: value for key, value in self.input_routes.items() if now - value[1] < 600}
            key = (owner, payload['request_id'])
            old = self.input_routes.get(key)
            if old and old[0] != pid:
                raise web.HTTPConflict(text='같은 전송 번호로 다른 서버나 화면에 보낼 수 없어요.')
            if len(self.input_routes) >= 4000 and not old:
                raise web.HTTPTooManyRequests(text='잠시 뒤에 다시 보내 주세요.')
            self.input_routes[key] = (pid, now)
        result = await self.backends[host.id].send(raw, payload, owner)
        return {**result, 'pane_id': pid}

    async def terminal(self, sid, sizing):
        host, raw = self.resolve(sid, '$')
        backend = self.backends[host.id]
        session = next((item for item in await backend.sessions(fresh=True) if item['id'] == raw), None)
        if session is None:
            raise web.HTTPNotFound(text='작업이 종료되었어요.')
        if sizing == 'window':
            _, error, code = await backend.command('set-window-option', '-t', session['terminal']['window_id'],
                                                   'window-size', 'latest', tolerate=True)
            if code:
                # tmux 3.0a has automatic sizing, but no "latest" policy. Keep
                # its existing policy and use a normal, sizing-aware client.
                # Do not pin the live window, detach clients or restart jobs.
                if b'unknown value: latest' in error:
                    sizing = 'legacy-window'
                else:
                    raise web.HTTPConflict(text='원본 터미널의 창 크기를 설정할 수 없어요. 다시 연결해 주세요.')
        if sizing == 'mirror':
            output, _, _ = await backend.command('list-commands')
            attach = next((line for line in output.decode().splitlines() if line.startswith('attach-session ')), '')
            if '-f flags' not in attach:
                raise web.HTTPConflict(text='이 서버의 구버전 tmux는 크기를 유지하는 원본 보기를 지원하지 않아요. 작업 보기를 사용해 주세요.')
        return host, raw, sizing
