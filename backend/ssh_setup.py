"""Use a password once to register a dedicated SSH key, without storing the password."""
import asyncio
import base64
import fcntl
from dataclasses import asdict, replace
import json
import os
from pathlib import Path
import secrets
import shlex
import time

from aiohttp import web


class SSHSetup:
    def __init__(self, state, fleet):
        self.state = Path(state)
        self.fleet = fleet
        self.locks = {}
        self.attempts = {}
        self.config_lock = asyncio.Lock()
        self.probes = {}

    async def probe(self, host_id):
        host = self.fleet.hosts.get(host_id)
        if host is None or host.local:
            raise web.HTTPNotFound(text='원격 서버를 선택해 주세요.')
        process = await asyncio.create_subprocess_exec('ssh-keyscan', '-T', '4', '-p', str(host.port), '--', host.address,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            output, _ = await asyncio.wait_for(process.communicate(), 6)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            raise web.HTTPGatewayTimeout(text='SSH 호스트 키를 읽을 수 없어요. 주소와 포트를 확인해 주세요.')
        lines = [line for line in output.decode(errors='replace').splitlines() if line and not line.startswith('#')]
        if not lines:
            raise web.HTTPBadGateway(text='SSH 응답이 없어요. 주소·포트와 원격 로그인을 확인해 주세요.')
        keys = ('\n'.join(lines) + '\n').encode()
        fingerprint = await asyncio.create_subprocess_exec('ssh-keygen', '-lf', '-', stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        output, _ = await fingerprint.communicate(keys)
        if fingerprint.returncode:
            raise web.HTTPBadGateway(text='호스트 키 형식을 확인할 수 없어요.')
        token = secrets.token_urlsafe(24)
        self.probes = {key: value for key, value in self.probes.items() if time.monotonic() - value[0] < 300}
        self.probes[token] = (time.monotonic(), host, keys)
        return {'token': token, 'fingerprints': output.decode().splitlines()}

    def trust(self, host, token):
        if not host.known_hosts_file:
            return
        probe = self.probes.get(token)
        if not probe or time.monotonic() - probe[0] > 300 or probe[1] != host:
            raise web.HTTPConflict(text='호스트 키를 다시 확인해 주세요.')
        directory = self.state / 'ssh'
        directory.mkdir(mode=0o700, exist_ok=True)
        path = directory / 'known_hosts'
        with path.open('a+') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            stream.seek(0);known=set(stream.read().splitlines());stream.seek(0,2)
            for line in probe[2].decode().splitlines():
                if line not in known:stream.write(line+'\n')
        path.chmod(0o600)

    async def key(self, host):
        directory = self.state / 'ssh'
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        directory.chmod(0o700)
        identity = directory / (host.id + '_ed25519')
        if not identity.exists():
            process = await asyncio.create_subprocess_exec('ssh-keygen', '-q', '-t', 'ed25519',
                '-N', '', '-f', str(identity), '-C', 'tmux-mobile@host:' + host.id,
                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            await process.communicate()
            if process.returncode:
                raise web.HTTPInternalServerError(text='연결용 키를 준비하지 못했어요.')
        identity.chmod(0o600)
        public = identity.with_suffix('.pub').read_text().strip()
        if not public.startswith('ssh-ed25519 ') or '\n' in public:
            raise web.HTTPInternalServerError(text='연결용 키를 확인해 주세요.')
        return identity, public

    async def install(self, host, identity, public, password):
        socket = self.state / ('askpass-' + secrets.token_hex(8) + '.sock')
        sent = False

        async def provide(reader, writer):
            nonlocal sent
            try:
                if await asyncio.wait_for(reader.read(1), 2) == b'P' and not sent:
                    sent = True
                    writer.write(password.encode('utf-8'))
                    await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()

        listener = await asyncio.start_unix_server(provide, path=socket)
        socket.chmod(0o600)
        # Retain all existing authorized keys; this entry disables forwarding.
        entry = 'no-agent-forwarding,no-port-forwarding,no-X11-forwarding ' + public
        command = 'umask 077; mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"; touch "$HOME/.ssh/authorized_keys"; chmod 600 "$HOME/.ssh/authorized_keys"; key=' + shlex.quote(entry) + '; grep -qxF -- "$key" "$HOME/.ssh/authorized_keys" || printf \'%s\\n\' "$key" >> "$HOME/.ssh/authorized_keys"'
        argv = host.ssh(['sh', '-c', command])
        if host.platform == 'windows':
            # Enroll the Windows SSH account, not the separate WSL account.
            script = r'''$ErrorActionPreference='Stop'
$admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$path=if($admin){Join-Path $env:ProgramData 'ssh/administrators_authorized_keys'}else{Join-Path $env:USERPROFILE '.ssh/authorized_keys'}
New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
$key=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__KEY__'))
if(!(Test-Path $path)){[IO.File]::WriteAllText($path,'')}
if(!([IO.File]::ReadAllLines($path) -contains $key)){[IO.File]::AppendAllText($path,"`n"+$key+"`n",[Text.UTF8Encoding]::new($false))}
if($admin){icacls.exe $path /inheritance:r /grant '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null}else{icacls.exe $path /inheritance:r /grant ($env:USERNAME+':F') '*S-1-5-18:F' | Out-Null}
if($LASTEXITCODE -ne 0){exit 1}
'''.replace('__KEY__', base64.b64encode(entry.encode()).decode())
            encoded = base64.b64encode(script.encode('utf-16le')).decode()
            argv[-1] = 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + encoded
        # Earlier options take precedence in OpenSSH. Keep password setup separate
        # from normal BatchMode connections and allow only one password prompt.
        argv[1:1] = ['-o', 'BatchMode=no', '-o', 'PubkeyAuthentication=no',
                     '-o', 'PreferredAuthentications=password,keyboard-interactive',
                     '-o', 'NumberOfPasswordPrompts=1']
        environment = {**os.environ, 'SSH_ASKPASS_REQUIRE': 'force', 'DISPLAY': 'tmux-mobile',
                       'SSH_ASKPASS': str(Path(__file__).parent / 'helpers/ssh_askpass.py'),
                       'TMUX_SETUP_SOCKET': str(socket)}
        process = None
        try:
            process = await asyncio.create_subprocess_exec(*argv, env=environment,
                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            try:
                _, error = await asyncio.wait_for(process.communicate(), 35)
            except asyncio.TimeoutError:
                raise web.HTTPGatewayTimeout(text='서버 응답이 늦어요. 잠시 후 다시 연결해 주세요.')
            if process.returncode:
                if b'Permission denied' in error:
                    raise web.HTTPForbidden(text='비밀번호 또는 계정을 확인해 주세요.')
                if b'Host key verification failed' in error or b'HOST IDENTIFICATION HAS CHANGED' in error:
                    raise web.HTTPConflict(text='서버 확인이 필요해요. 저장된 SSH 호스트 키를 확인해 주세요.')
                raise web.HTTPBadGateway(text='서버 연결 설정을 완료하지 못했어요.')
        finally:
            if process is not None and process.returncode is None:
                process.kill()
                await process.wait()
            listener.close()
            await listener.wait_closed()
            socket.unlink(missing_ok=True)

    async def connect(self, host_id, password, trust=''):
        host = self.fleet.hosts.get(host_id)
        if host is None or host.local:
            raise web.HTTPNotFound(text='연결할 원격 서버를 찾을 수 없어요.')
        if not isinstance(password, str) or not password or len(password.encode('utf-8')) > 1024 or any(char in password for char in '\r\n\0'):
            raise web.HTTPBadRequest(text='서버 비밀번호를 입력해 주세요.')
        lock = self.locks.setdefault(host_id, asyncio.Lock())
        if lock.locked():
            raise web.HTTPConflict(text='이 서버에 연결 중이에요. 잠시 기다려 주세요.')
        async with lock:
            if host.known_hosts_file and trust:
                self.trust(host, trust)
            now = time.monotonic()
            attempts = [stamp for stamp in self.attempts.get(host_id, []) if now - stamp < 60]
            if len(attempts) >= 3:
                raise web.HTTPTooManyRequests(text='1분 뒤에 다시 연결해 주세요.')
            self.attempts[host_id] = [*attempts, now]
            identity, public = await self.key(host)
            await self.install(host, identity, public, password)
            password = ''
            configured = replace(host, identity_file=str(identity))
            process = await asyncio.create_subprocess_exec(*configured.ssh(['true']),
                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            try:
                await asyncio.wait_for(process.communicate(), 8)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
                raise web.HTTPGatewayTimeout(text='키 연결 확인이 늦어요. 다시 연결해 주세요.')
            if process.returncode:
                raise web.HTTPBadGateway(text='서버가 연결용 키를 허용하지 않았어요. SSH 설정을 확인해 주세요.')
            async with self.config_lock:
                config = self.state / 'hosts.json'
                with (self.state / 'hosts.lock').open('a') as file_lock:
                    fcntl.flock(file_lock, fcntl.LOCK_EX)
                    source = json.loads(config.read_text())
                    item = next((item for item in source['hosts'] if item['id'] == host_id), None)
                    if not item or any(item.get(key, getattr(host, key)) != getattr(host, key) for key in ('address', 'user', 'port', 'platform')):
                        raise web.HTTPConflict(text='서버 설정이 바뀌었어요. 다시 연결해 주세요.')
                    item['identity_file'] = str(identity)
                    temporary = config.with_name('hosts-' + secrets.token_hex(8) + '.tmp')
                    temporary.write_text(json.dumps(source, ensure_ascii=False, indent=2) + '\n')
                    temporary.chmod(0o600)
                    temporary.replace(config)
                self.fleet.hosts[host_id] = configured
                self.fleet.backends[host_id].runner = configured.command
                self.fleet.backends[host_id].transcript_runner = configured.conversation
                self.fleet.backends[host_id].agent_runner = configured.agent
                self.fleet.backends[host_id].catalog_runner = configured.catalog
                self.fleet.refreshed[host_id] = 0
            self.attempts.pop(host_id, None)
            return {'ok': True, 'host': host_id}
