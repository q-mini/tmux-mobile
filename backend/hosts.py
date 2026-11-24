"""Configured tmux hosts. Browser requests can select only these fixed targets."""
import asyncio
import base64
import fcntl
import getpass
import ipaddress
import secrets
from dataclasses import dataclass, field
import json
from pathlib import Path
import re
import shlex

from aiohttp import web

TRANSCRIPT_READER = Path(__file__).with_name('claude_history.py').read_text()
AGENT_READER = Path(__file__).with_name('agent_identity.py').read_text()
CATALOG_READER = Path(__file__).with_name('agent_catalog.py').read_text()

# Probe before executing any mutation: some tmux clients return success after
# creating a session even though an older server cannot format the response.
# This launcher is shared by API commands and interactive terminal attachment.
TMUX_LAUNCHER = '''import json,os,pathlib,shutil,subprocess,sys
args=json.loads(sys.argv[1])
candidates=[shutil.which('tmux'),'/usr/bin/tmux','/usr/local/bin/tmux',str(pathlib.Path.home()/'.local/bin/tmux')]
seen=set()
for candidate in candidates:
 if not candidate or candidate in seen or not os.access(candidate,os.X_OK): continue
 seen.add(candidate)
 try:
  probe=subprocess.run([candidate,'display-message','-p','#{version}'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=1)
 except (OSError,subprocess.TimeoutExpired): continue
 error=probe.stderr.lower()
 if b'server version is too old' in error or b'protocol version mismatch' in error: continue
 if probe.returncode and not any(message in error for message in [b'no server running',b'no sessions',b'error connecting']): continue
 os.execv(candidate,[candidate,*args[1:]])
sys.stderr.write('tmux compatible client unavailable\\n')
sys.exit(69)
'''


@dataclass(frozen=True)
class Host:
    id: str
    name: str
    address: str = ''
    user: str = field(default_factory=getpass.getuser)
    port: int = 22
    local: bool = False
    identity_file: str = ''
    platform: str = 'linux'
    known_hosts_file: str = ''

    def remote_command(self, command):
        if command and command[0] == 'tmux':
            command = ['python3', '-c', TMUX_LAUNCHER, json.dumps(list(command))]
        if self.platform == 'windows':
            encoded = base64.b64encode(json.dumps(list(command)).encode()).decode()
            # This command contains no shell metacharacters in the payload and
            # works with either cmd.exe or PowerShell as OpenSSH's default shell.
            code = "import base64,json,os; a=json.loads(base64.b64decode('" + encoded + "')); os.execvp(a[0],a)"
            return 'wsl.exe --exec python3 -c "' + code + '"'
        return shlex.join(command)

    def ssh(self, command, tty=False):
        options = ['ssh', '-tt' if tty else '-T', '-p', str(self.port),
                   '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3',
                   '-o', 'ConnectionAttempts=1', '-o', 'StrictHostKeyChecking=yes',
                   '-o', 'ClearAllForwardings=yes', '-o', 'ServerAliveInterval=10',
                   '-o', 'ServerAliveCountMax=2']
        if self.identity_file:
            options += ['-o', 'IdentitiesOnly=yes', '-i', str(Path(self.identity_file).expanduser())]
        if self.known_hosts_file:
            options += ['-o', 'UserKnownHostsFile=' + self.known_hosts_file]
        return options + ['--', self.user + '@' + self.address, self.remote_command(command)]

    def script(self, code, data):
        if self.platform == 'windows':
            # Windows command lines have a short size limit. Stream reader code
            # through stdin instead of embedding it in the WSL command line.
            wrapper="import io,json,sys; d=json.load(sys.stdin); sys.stdin=io.StringIO(d['input']); exec(compile(d['code'],'<tmux-reader>','exec'))"
            return self.ssh(['python3','-c',wrapper]), json.dumps({'code':code,'input':data.decode()}).encode()
        return self.ssh(['python3','-c',code]), data

    async def command(self, *args, data=None, tolerate=False):
        process = await asyncio.create_subprocess_exec(*self.ssh(['tmux', *args]),
            stdin=asyncio.subprocess.PIPE if data is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            output, error = await asyncio.wait_for(process.communicate(data), timeout=8)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            raise web.HTTPServiceUnavailable(text='서버 연결 지연')
        except BaseException:
            if process.returncode is None:
                process.kill()
                await process.wait()
            raise
        if process.returncode == 255:
            if b'Permission denied' in error:
                message = 'SSH 로그인 설정 필요'
            elif b'Host key verification failed' in error or b'HOST IDENTIFICATION HAS CHANGED' in error:
                message = 'SSH 서버 확인 필요'
            else:
                message = '서버에 연결할 수 없어요'
            raise web.HTTPServiceUnavailable(text=message)
        if b'tmux compatible client unavailable' in error:
            raise web.HTTPServiceUnavailable(text='실행 중인 tmux와 호환되는 명령어를 찾을 수 없어요.')
        if b'tmux' in error and (b'command not found' in error or b'not found' in error) and process.returncode == 127:
            raise web.HTTPServiceUnavailable(text='tmux 설치 필요')
        if process.returncode and not tolerate:
            raise web.HTTPConflict(text='화면이 종료되었거나 입력할 수 없는 상태예요. 목록을 새로고침해 주세요.')
        return output, error, process.returncode

    async def conversation(self, pane, before='', known='', media=''):
        argv, data = self.script(TRANSCRIPT_READER,json.dumps({'pane': pane, 'before': before, 'known': known, 'media': media}).encode())
        process = await asyncio.create_subprocess_exec(*argv,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            output, _ = await asyncio.wait_for(process.communicate(data), timeout=20 if media else 8)
        except BaseException:
            if process.returncode is None:
                process.kill()
            await process.wait()
            raise
        if process.returncode:
            raise web.HTTPServiceUnavailable(text='서버의 Claude 대화 기록을 읽을 수 없어요.')
        return json.loads(output)

    async def agent(self, root_pid):
        argv,data=self.script(AGENT_READER,str(int(root_pid)).encode())
        process = await asyncio.create_subprocess_exec(*argv,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            output, _ = await asyncio.wait_for(process.communicate(data), timeout=8)
            return json.loads(output) if not process.returncode else None
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()

    async def catalog(self, pane, agent):
        argv,data=self.script(CATALOG_READER,json.dumps({'agent': agent, 'path': pane.get('path') or '/'}).encode())
        process = await asyncio.create_subprocess_exec(*argv,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            output, _ = await asyncio.wait_for(process.communicate(data), timeout=45)
            if process.returncode:
                raise web.HTTPServiceUnavailable(text='선택한 서버의 스킬 목록을 읽을 수 없어요.')
            return json.loads(output)
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()


def validate_host(host):
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', host.id):
        raise ValueError('Host IDs must be unique short names')
    if not isinstance(host.name, str) or not 1 <= len(host.name.strip()) <= 60 or any(ord(c) < 32 for c in host.name):
        raise ValueError('서버 이름을 1~60자로 입력해 주세요.')
    try:
        ipaddress.ip_address(host.address)
        address_ok = True
    except ValueError:
        address_ok = bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{0,252}', host.address))
    if not host.local and (not address_ok or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.@-]{0,63}', host.user)
            or type(host.port) is not int or not 1 <= host.port <= 65535):
        raise ValueError('주소·SSH 포트·사용자 이름을 확인해 주세요.')
    if host.platform not in {'linux', 'macos', 'windows'}:
        raise ValueError('지원하지 않는 운영체제예요.')
    return host


def save_host(state, action, values):
    """Serialize updates across the three apps; never accept credential paths."""
    from dataclasses import asdict, replace
    state = Path(state)
    state.mkdir(parents=True, exist_ok=True)
    with (state / 'hosts.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = load_hosts(state)
        old = next((h for h in current if h.id == values.get('id')), None)
        if action == 'remove':
            if old is None or old.local:
                raise ValueError('이 서버는 목록에서 제거할 수 없어요.')
            current.remove(old)
            result = old
        else:
            if action == 'edit' and old is None:
                raise ValueError('서버를 찾을 수 없어요.')
            allowed = {'name', 'address', 'user', 'port', 'platform'}
            fields = {key: value for key, value in values.items() if key in allowed}
            if old and old.local and set(fields) - {'name'}:
                raise ValueError('현재 서버는 이름만 변경할 수 있어요.')
            if old:
                result = validate_host(replace(old, **fields))
                if any(getattr(old, key) != getattr(result, key) for key in ('address', 'user', 'port', 'platform')):
                    # A new endpoint must not inherit pane IDs, input receipts
                    # or drafts that belonged to the previous SSH account.
                    result = replace(result, id='ssh-'+secrets.token_hex(4), identity_file='',known_hosts_file=str(state/'ssh'/'known_hosts'))
                current[current.index(old)] = result
            else:
                if len(current) >= 40:
                    raise ValueError('서버는 최대 40개까지 등록할 수 있어요.')
                result = validate_host(Host(id='ssh-' + secrets.token_hex(4), **fields,
                    known_hosts_file=str(state / 'ssh' / 'known_hosts')))
                current.append(result)
        path = state / 'hosts.json'
        source = json.loads(path.read_text()) if path.exists() else {}
        source['hosts'] = [asdict(h) for h in current]
        temporary = path.with_name('hosts-' + secrets.token_hex(8) + '.tmp')
        temporary.write_text(json.dumps(source, ensure_ascii=False, indent=2) + '\n')
        temporary.chmod(0o600)
        temporary.replace(path)
        return result


def load_hosts(state):
    path = Path(state) / 'hosts.json'
    if not path.exists():
        return [Host('local', 'Local', local=True)]
    source = json.loads(path.read_text())
    hosts = []
    for item in source['hosts']:
        host = Host(**item)
        validate_host(host)
        if any(old.id == host.id for old in hosts):
            raise ValueError('Host IDs must be unique short names')
        hosts.append(host)
    if sum(host.local for host in hosts) != 1:
        raise ValueError('Configure exactly one local host')
    return hosts
