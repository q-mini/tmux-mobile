"""Pane-oriented reading and input without resizing or selecting desktop panes."""
import asyncio
import hashlib
import re
import secrets
import time
from .claude_history import read_conversation, async_question_groups
from .interactions import dialog, RULE
from .delivery import pending_input, PROMPT, ghost_prompt
from .agent_identity import identify
from .agent_catalog import catalog as read_catalog
from .agent_commands import model_command_ready,claude_status

from aiohttp import web

SEP = '\t'
FIELDS = ['session_id', 'session_name', 'session_windows', 'session_attached', 'window_id', 'window_index', 'window_name', 'window_active', 'pane_id', 'pane_index', 'pane_title', 'pane_current_command', 'pane_current_path', 'pane_width', 'pane_height', 'pane_active', 'pane_dead', 'window_width', 'window_height', 'status', 'window_zoomed_flag', 'history_size', 'pane_pid', 'pane_left', 'pane_top']
KEYS = {'escape': 'Escape', 'tab': 'Tab', 'up': 'Up', 'down': 'Down', 'left': 'Left', 'right': 'Right', 'enter': 'Enter', 'interrupt': 'C-c', 'backspace': 'BSpace', 'delete': 'DC', 'home': 'Home', 'end': 'End'}
INTERACTION_KEYS = {key: KEYS[key] for key in ['escape', 'tab', 'up', 'down', 'left', 'right', 'enter']}
ANSI_ESCAPE = re.compile(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-2A-Z]|[@-_])')


async def command(*args, data=None, tolerate=False):
    process = await asyncio.create_subprocess_exec('tmux', *args, stdin=asyncio.subprocess.PIPE if data is not None else asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        output, error = await asyncio.wait_for(process.communicate(data), timeout=4)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        raise web.HTTPGatewayTimeout(text='tmux 응답이 지연되고 있어요.')
    except BaseException:
        if process.returncode is None:
            process.kill()
            await process.wait()
        raise
    if process.returncode and not tolerate:
        raise web.HTTPConflict(text='화면이 종료되었거나 입력할 수 없는 상태예요. 목록을 새로고침해 주세요.')
    return output, error, process.returncode


class Workspace:
    def __init__(self, excluded, runner=None, transcript_runner=None, agent_runner=None, catalog_runner=None):
        self.excluded = set(excluded)
        self.runner = runner
        self.transcript_runner = transcript_runner
        self.agent_runner = agent_runner
        self.catalog_runner = catalog_runner
        self.catalog_cache = {}
        self.catalog_pending = {}
        self.inventory_cache = (0, [])
        self.snapshots = {}
        self.input_lock = asyncio.Lock()
        self.receipts = {}
        self.async_answers = {}
        self.interaction_salt = secrets.token_hex(16)

    async def command(self, *args, **kwargs):
        return await (self.runner or command)(*args, **kwargs)

    async def sessions(self, fresh=False):
        now = time.monotonic()
        if not fresh and now - self.inventory_cache[0] < 0.7:
            return self.inventory_cache[1]
        output, error, status = await self.command('list-panes', '-a', '-F', SEP.join('#{' + key + '}' for key in FIELDS), tolerate=True)
        if status:
            if any(text in error for text in [b'no server running', b'no sessions', b'error connecting']):
                return []
            raise web.HTTPServiceUnavailable(text='tmux 목록을 불러올 수 없어요.')
        sessions = {}
        for line in output.decode('utf-8', errors='replace').splitlines():
            values = line.split(SEP)
            if len(values) != len(FIELDS):
                continue
            item = dict(zip(FIELDS, values))
            if item['session_name'] in self.excluded:
                continue
            sid = item['session_id']
            session = sessions.setdefault(sid, {'id': sid, 'name': item['session_name'], 'windows': int(item['session_windows']), 'attached': int(item['session_attached']), 'panes': []})
            if item['window_active'] == '1':
                status = item['status']
                status_rows = 1 if status == 'on' else int(status) if status.isdigit() else 0
                session['terminal'] = {'cols': int(item['window_width']), 'rows': int(item['window_height']) + status_rows, 'window_id': item['window_id'], 'zoomed': item['window_zoomed_flag'] == '1'}
            session['panes'].append({
                'id': item['pane_id'], 'session_id': sid, 'window_id': item['window_id'],
                'window_index': int(item['window_index']), 'window_name': item['window_name'],
                'index': int(item['pane_index']), 'title': item['pane_title'],
                'command': item['pane_current_command'], 'path': item['pane_current_path'],
                'width': int(item['pane_width']), 'height': int(item['pane_height']),
                'left': int(item['pane_left']), 'top': int(item['pane_top']),
                'active': item['pane_active'] == '1' and item['window_active'] == '1',
                'dead': item['pane_dead'] == '1',
                'history_size': int(item['history_size']),
                'pid': int(item['pane_pid']),
            })
        result = list(sessions.values())
        for session in result:
            session['panes'].sort(key=lambda pane: (pane['window_index'], pane['index']))
            primary = next((pane for pane in session['panes'] if pane['active']), session['panes'][0])
            session['path'] = primary['path']
            session['pane_count'] = len(session['panes'])
        self.inventory_cache = (now, result)
        return result

    async def pane(self, pid, fresh=False):
        if not isinstance(pid, str) or not re.fullmatch(r'%\d+', pid):
            raise web.HTTPNotFound(text='화면을 찾을 수 없어요.')
        for session in await self.sessions(fresh=fresh):
            for pane in session['panes']:
                if pane['id'] == pid:
                    return pane
        raise web.HTTPNotFound(text='종료된 화면이에요. 다른 작업을 선택해 주세요.')

    async def create_session(self, name, path=''):
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,59}', name) or name in self.excluded:
            raise web.HTTPBadRequest(text='세션 이름은 영문·숫자로 시작하는 1~60자의 영문·숫자·밑줄·하이픈으로 입력해 주세요.')
        if not isinstance(path, str) or len(path) > 4096 or path and (not path.startswith('/') or any(ord(c) < 32 for c in path)):
            raise web.HTTPBadRequest(text='시작 폴더는 서버의 절대 경로로 입력해 주세요.')
        output, error, status = await self.command('new-session', '-d', '-P', '-F', '#{session_id}', '-s', name,
                                                  '-x', '120', '-y', '36', *(['-c', path] if path else []), tolerate=True)
        if status:
            message = '같은 이름의 세션이 이미 있어요.' if b'duplicate session' in error else '세션을 만들 수 없어요. 시작 폴더와 서버 상태를 확인해 주세요.'
            raise web.HTTPConflict(text=message)
        sid = output.decode().strip()
        self.inventory_cache = (0, [])
        session = next((item for item in await self.sessions(fresh=True) if item['id'] == sid), None)
        if session is None:
            raise web.HTTPConflict(text='생성한 세션 정보를 확인할 수 없어요. 목록을 새로고침한 뒤 확인해 주세요.')
        await self.command('set-window-option', '-t', session['terminal']['window_id'], 'window-size', 'latest', tolerate=True)
        return session

    async def manage_session(self, sid, action, name=None):
        session = next((s for s in await self.sessions(fresh=True) if s['id'] == sid), None)
        if session is None:
            raise web.HTTPNotFound(text='세션이 종료됐어요.')
        if action == 'rename':
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60 or any(ord(c) < 32 or c in '.:' for c in name) or name.startswith('-') or name in self.excluded:
                raise web.HTTPBadRequest(text='이름은 1~60자로 입력하고 마침표·콜론은 빼 주세요.')
            _, error, status = await self.command('rename-session', '-t', sid, name.strip(), tolerate=True)
            if status:
                raise web.HTTPConflict(text='같은 이름이 있거나 세션이 종료됐어요.')
        elif action == 'delete':
            await self.command('kill-session', '-t', sid)
        else:
            raise web.HTTPBadRequest(text='지원하지 않는 세션 작업이에요.')
        self.inventory_cache = (0, [])

    async def snapshot(self, pid, known='', history=800, grid=False):
        if type(history) is not int or not 800 <= history <= 100000 or type(grid) is not bool:
            raise web.HTTPBadRequest(text='잘못된 이전 출력 범위예요.')
        pane = await self.pane(pid)
        now = time.monotonic()
        previous = self.snapshots.get(pid)
        if previous is None or now - previous['captured'] > 0.65 or previous.get('history') != history or previous.get('grid') != grid:
            output, _, _ = await self.command('capture-pane', '-p', '-e', *([] if grid else ['-J']), '-t', pid, '-S', '-' + str(history), '-E', '-1' if grid else '-')
            if grid and not pane.get('history_size', 0):
                output = b''
            byte_limit = 4 * 1024 * 1024
            clipped = len(output) > byte_limit
            ansi = output[-byte_limit:].decode('utf-8', errors='replace').rstrip('\n')
            text = ANSI_ESCAPE.sub('', ansi)
            text = '\n'.join(line.rstrip() for line in text.splitlines()).rstrip()
            version = hashlib.sha256(ansi.encode()).hexdigest()[:20]
            changed_at = time.time() if previous is None or version != previous['version'] else previous['changed_at']
            previous = {'captured': now, 'text': text, 'ansi': ansi, 'version': version, 'changed_at': changed_at,
                        'history': history, 'grid': grid, 'clipped': clipped}
            self.snapshots[pid] = previous
            if len(self.snapshots) > 64:
                oldest = min(self.snapshots, key=lambda item: self.snapshots[item]['captured'])
                self.snapshots.pop(oldest, None)
        changed = known != previous['version']
        more = pane.get('history_size', 0) > history and history < 100000 and not previous['clipped']
        return {'pane': pane, 'version': previous['version'], 'changed': changed, 'changed_at': previous['changed_at'],
                'history': history, 'history_more': more, 'history_clipped': previous['clipped'],
                **({'text': previous['text'], 'ansi': previous['ansi']} if changed else {})}

    async def conversation(self, pid, before='', known=''):
        pane = await self.pane(pid)
        if not pane.get('pid') or pane.get('command') not in {'claude', 'codex', 'node', 'bash', 'zsh', 'python', 'python3'}:
            return {'source': None}
        try:
            if pane.get('command') in {'codex', 'node'}:
                output, _, _ = await self.command('capture-pane', '-p', '-J', '-t', pid, '-S', '-800')
                pane = dict(pane, screen=output.decode('utf-8', errors='replace'))
            if self.transcript_runner is not None:
                result = await self.transcript_runner(pane, before, known)
            elif self.runner is not None:
                return {'source': None}
            else:
                result = await asyncio.to_thread(read_conversation, pane, before, known)
            if result.get('source') == 'claude' and not before:
                # Read only the visible footer, never the editable input as a message.
                output, _, _ = await self.command('capture-pane', '-p', '-J', '-t', pid)
                lines = ANSI_ESCAPE.sub('', output.decode('utf-8', errors='replace')).splitlines()[-12:]
                result['status_lines'] = [line.strip() for line in lines if re.match(r'^\s*(?:(?:Opus|Sonnet|Haiku)\b|⏵)', line)]
            return result
        except ValueError as error:
            raise web.HTTPBadRequest(text=str(error))
        except OSError:
            return {'source': None}

    async def interaction(self, pid, grid=False):
        pane = await self.pane(pid, fresh=grid)
        output, _, _ = await self.command('capture-pane', '-p', '-e', *([] if grid else ['-J']), '-t', pid)
        frame = dialog(output.decode('utf-8', errors='replace'), positions=grid)
        if frame is not None:
            if grid:
                frame['grid'] = {'cols': pane['width'], 'rows': pane['height']}
                flags, _, _ = await self.command('display-message', '-p', '-t', pid, '#{mouse_any_flag}:#{mouse_button_flag}:#{mouse_standard_flag}')
                frame['mouse'] = '1' in flags.decode().strip().split(':')
            identity = repr((self.interaction_salt, pid, pane.get('pid'), frame))
            frame['token'] = hashlib.sha256(identity.encode()).hexdigest()[:32]
        return frame

    async def catalog(self, pid):
        pane = await self.pane(pid)
        agent = await self.agent(pane)
        key = (pid, pane.get('pid'), pane.get('path'), agent)
        cached = self.catalog_cache.get(key)
        if not cached or time.monotonic()-cached[0] > 5:
            pending = self.catalog_pending.get(key)
            if pending is None:
                async def load():
                    return await self.catalog_runner(pane, agent) if self.catalog_runner else await asyncio.to_thread(read_catalog, agent, pane.get('path') or '/')
                pending = self.catalog_pending[key] = asyncio.create_task(load())
            try:
                data = await asyncio.shield(pending)
                self.catalog_cache[key] = (time.monotonic(), data)
            finally:
                if pending.done():
                    self.catalog_pending.pop(key, None)
        else:
            data = cached[1]
        output, _, _ = await self.command('capture-pane', '-p', '-e', '-J', '-t', pid)
        screen = output.decode('utf-8', errors='replace')
        ready, reason = model_command_ready(screen, agent)
        token = hashlib.sha256(repr((self.interaction_salt, pid, pane.get('pid'), agent, screen)).encode()).hexdigest()[:32]
        return {**data, 'model_ready': ready, 'model_reason': reason, 'command_token': token}

    async def agent(self, pane):
        if pane.get('command') in {'claude', 'codex'}:
            return pane['command'].capitalize()
        if pane.get('command') == 'node':
            return await self.agent_runner(pane['pid']) if self.agent_runner else await asyncio.to_thread(identify, pane['pid'])
        return None

    async def agent_state(self,pid):
        pane=await self.pane(pid);agent=await self.agent(pane)
        output,_,_=await self.command('capture-pane','-p','-e','-J','-t',pid)
        screen=output.decode('utf-8',errors='replace')
        ready,reason=model_command_ready(screen,agent)
        token=hashlib.sha256(repr((self.interaction_salt,pid,pane.get('pid'),agent,screen)).encode()).hexdigest()[:32]
        return {'agent':agent,'ready':ready,'reason':reason,'command_token':token,**(claude_status(screen) if agent=='Claude' else {})}

    async def pending_input(self, pid):
        pane = await self.pane(pid)
        output, _, _ = await self.command('capture-pane', '-p', '-e', '-J', '-t', pid)
        source = output.decode('utf-8', errors='replace')
        if not pending_input(source):
            return None
        actor = await self.agent(pane)
        frame = pending_input(source, actor) if actor in {'Claude', 'Codex'} else None
        if frame:
            identity = repr((self.interaction_salt, pid, pane.get('pid'), frame))
            frame['token'] = hashlib.sha256(identity.encode()).hexdigest()[:32]
        return frame

    async def send(self, pid, payload, owner):
        if not isinstance(payload, dict):
            raise web.HTTPBadRequest(text='잘못된 입력이에요.')
        request_id = payload.get('request_id')
        if not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{12,100}', request_id):
            raise web.HTTPBadRequest(text='전송 번호가 없어요. 페이지를 새로 열어 주세요.')
        kind = payload.get('type', 'text')
        text = payload.get('text', '')
        key = payload.get('key')
        submit = payload.get('submit', True)
        choice, token = payload.get('choice'), payload.get('token')
        answer = payload.get('answer')
        if answer is not None and kind not in {'interaction', 'async_question'}:
            raise web.HTTPBadRequest(text='질문 화면에서 직접 답변해 주세요.')
        if kind == 'raw':
            if not isinstance(text, str) or not text or len(text.encode('utf-8')) > 4096:
                raise web.HTTPBadRequest(text='직접 입력은 한 번에 4KB까지 보낼 수 있어요.')
        elif kind == 'text':
            if not isinstance(text, str) or not text.strip() or len(text.encode('utf-8')) > 32000 or type(submit) is not bool:
                raise web.HTTPBadRequest(text='내용을 32KB 이내로 입력해 주세요.')
            if any(ord(char) < 32 and char not in '\n\r\t' for char in text) or '\x7f' in text:
                raise web.HTTPBadRequest(text='제어 문자가 포함된 내용은 보낼 수 없어요.')
            text = text.replace('\r\n', '\n').replace('\r', '\n')
        elif kind == 'async_question':
            if (not isinstance(payload.get('call_id'), str) or not 1 <= len(payload['call_id']) <= 200
                    or not isinstance(payload.get('question_id'), str) or not 1 <= len(payload['question_id']) <= 8000
                    or not isinstance(payload.get('session_id'), str) or len(payload['session_id']) > 200
                    or type(choice) is not int or not 0 <= choice < 30 or answer is not None or key is not None):
                raise web.HTTPBadRequest(text='질문 선택지를 다시 확인해 주세요.')
        elif kind in {'interaction', 'send_now', 'agent_command'}:
            if not isinstance(token, str) or not re.fullmatch(r'[0-9a-f]{32}', token):
                raise web.HTTPBadRequest(text='질문 화면을 다시 불러와 주세요.')
            if kind == 'agent_command':
                action=payload.get('command')
                if action not in {'model','login','mode','login-key','login-code'} or choice is not None:
                    raise web.HTTPBadRequest(text='지원하지 않는 에이전트 명령이에요.')
                if action=='login-key':
                    if key not in {'up','down','enter','escape','tab'}:raise web.HTTPBadRequest(text='지원하지 않는 키예요.')
                    text='login-key:'+key
                elif key is not None:raise web.HTTPBadRequest(text='지원하지 않는 키예요.')
                elif action=='login-code':
                    if not isinstance(text,str) or not 1<=len(text)<=4096 or any(ord(c)<32 for c in text):raise web.HTTPBadRequest(text='로그인 코드를 확인해 주세요.')
                else:text='/'+action
                submit = True
            elif kind == 'send_now':
                if choice is not None or key is not None:
                    raise web.HTTPBadRequest(text='대기 메시지 전송 요청을 확인해 주세요.')
            elif answer is not None:
                if choice is not None or key is not None or not isinstance(answer, str) or not answer.strip() or len(answer.encode()) > 32000 or any(ord(c) < 32 and c not in '\n\t' for c in answer) or '\x7f' in answer:
                    raise web.HTTPBadRequest(text='직접 답변 내용을 32KB 이내로 입력해 주세요.')
                text, submit = answer, True
            elif choice is not None:
                if type(choice) is not int or not 1 <= choice <= 30 or key is not None:
                    raise web.HTTPBadRequest(text='잘못된 선택지예요.')
            elif not isinstance(key, str) or key not in INTERACTION_KEYS:
                raise web.HTTPBadRequest(text='지원하지 않는 질문 조작이에요.')
        elif kind != 'key' or not isinstance(key, str) or key not in KEYS:
            raise web.HTTPBadRequest(text='지원하지 않는 키예요.')
        fingerprint = hashlib.sha256(repr((pid, kind, text, key, submit, choice, token, payload.get('call_id'), payload.get('question_id'), payload.get('session_id'))).encode()).hexdigest()
        receipt_key = (owner, request_id)
        async with self.input_lock:
            now = time.monotonic()
            self.receipts = {key: value for key, value in self.receipts.items() if now - value['time'] < 600}
            old = self.receipts.get(receipt_key)
            if old:
                if old['fingerprint'] != fingerprint:
                    raise web.HTTPConflict(text='같은 전송 번호로 다른 내용을 보낼 수 없어요.')
                return dict(old['result'], duplicate=True)
            if len(self.receipts) >= 1000:
                raise web.HTTPTooManyRequests(text='잠시 뒤에 다시 보내 주세요.')
            pane = await self.pane(pid, fresh=True)
            if pane['dead']:
                raise web.HTTPConflict(text='종료된 화면에는 입력할 수 없어요.')
            interaction_keys = []
            async_identity = None
            if kind == 'async_question':
                data = await self.conversation(pid)
                if data.get('source') != 'codex' or data.get('session_id') != payload['session_id']:
                    raise web.HTTPConflict(text='질문의 대화 세션이 바뀌었어요. 새로고침해 주세요.')
                messages, cursor = data.get('messages', []), data.get('before')
                for _ in range(4):
                    if any(item.get('question', {}).get('call_id') == payload['call_id'] for item in messages) or not cursor:
                        break
                    older = await self.conversation(pid, before=cursor)
                    messages = older.get('messages', []) + messages
                    cursor = older.get('before')
                group = async_question_groups(messages).get(payload['call_id'], {})
                question = next((q for q in group.get('questions', []) if q['id'] == payload['question_id']), None)
                async_identity = (pid, pane.get('pid'), payload['session_id'], payload['call_id'], payload['question_id'])
                if (not group.get('async') or question is None or group.get('answers', {}).get(question['id'])
                        or async_identity in self.async_answers or choice >= len(question['options'])):
                    raise web.HTTPConflict(text='이미 답변했거나 현재 답변할 수 없는 질문이에요.')
                text = question['options'][choice]['label']
                if len(group['questions']) > 1:
                    text = question['prompt'] + '\n답변: ' + text
                if any(ord(c)<32 and c not in '\n\t' for c in text) or '\x7f' in text:
                    raise web.HTTPConflict(text='질문의 선택지에 보낼 수 없는 제어 문자가 있어요.')
                submit = True
                screen = (await self.command('capture-pane', '-p', '-e', '-J', '-t', pid))[0].decode(errors='replace')
                if dialog(screen):
                    raise web.HTTPConflict(text='원본 터미널의 선택 화면을 먼저 마쳐 주세요.')
                raw = screen.splitlines()
                lines = [ANSI_ESCAPE.sub('', line).rstrip() for line in raw]
                at = next((i for i in range(len(lines)-1, max(-1,len(lines)-16),-1) if PROMPT.match(lines[i])), None)
                if at is None or PROMPT.match(lines[at])[1].strip() and not ghost_prompt(raw[at]):
                    raise web.HTTPConflict(text='원본 터미널에 작성 중인 입력이 있어요. 그대로 보존했습니다.')
                for line in lines[at+1:]:
                    if RULE.fullmatch(line):
                        break
                    if line.strip() and not re.search(r'\b(?:gpt[- ]?\d|codex|o[134]\b)|for shortcuts|for agents', line, re.I):
                        raise web.HTTPConflict(text='원본 터미널의 여러 줄 입력을 그대로 보존했습니다.')
            elif kind == 'agent_command':
                action=payload['command']
                current=await self.catalog(pid) if action=='model' else await self.agent_state(pid)
                ready=current.get('model_ready',current.get('ready'))
                if action!='model' and current.get('agent')!='Claude':raise web.HTTPConflict(text='Claude 화면에서 사용할 수 있어요.')
                if action in {'login-key','login-code'}:ready=bool(current.get('login_screen'))
                if current['command_token'] != token or not ready:
                    raise web.HTTPConflict(text=current.get('model_reason') or current.get('reason') or 'CLI 화면이 바뀌었어요. 다시 확인해 주세요.')
            elif kind == 'send_now':
                frame = await self.pending_input(pid)
                if not frame or frame['token'] != token:
                    raise web.HTTPConflict(text='대기 메시지가 이미 전달됐거나 화면이 바뀌었어요.')
                interaction_keys = frame['keys']
            elif kind == 'interaction':
                frame = await self.interaction(pid)
                if not frame or frame['token'] != token:
                    raise web.HTTPConflict(text='질문 화면이 바뀌었어요. 새 선택지를 확인해 주세요.')
                if answer is not None:
                    if frame['kind'] == 'input' and frame.get('input_empty'):
                        pass
                    elif frame.get('custom_choice') is not None and frame['selected'] is not None:
                        target = next(i for i,item in enumerate(frame['options']) if item['number'] == frame['custom_choice'])
                        distance = target - frame['selected']
                        if distance:
                            await self.command('send-keys', '-t', pid, *(['Down' if distance > 0 else 'Up'] * abs(distance)))
                            await asyncio.sleep(.12)
                        current = await self.interaction(pid)
                        if not current or current['title'] != frame['title'] or current.get('custom_choice') != frame['custom_choice'] or current['selected'] != target:
                            raise web.HTTPConflict(text='직접 답변 입력 위치가 바뀌었어요. 다시 확인해 주세요.')
                    else:
                        raise web.HTTPConflict(text='원본 터미널의 작성 중인 답변을 보존했습니다. 입력 위치를 확인해 주세요.')
                elif choice is not None:
                    selected = frame['selected']
                    target = next((i for i, item in enumerate(frame['options']) if item['number'] == choice), None)
                    if target is None and choice == frame.get('chat_choice'):
                        target = len(frame['options'])
                    if selected is None or target is None:
                        raise web.HTTPConflict(text='현재 선택 위치를 확인할 수 없어요. 질문을 다시 불러와 주세요.')
                    distance = (frame['options'][target]['number'] - frame['options'][selected]['number']
                                if frame.get('purpose') == 'model' else target - selected)
                    forward,backward=('Right','Left') if frame.get('navigation_axis')=='horizontal' else ('Down','Up')
                    interaction_keys = [forward if distance > 0 else backward] * abs(distance) + ['Space' if frame['kind'] == 'multi' else frame.get('select_key', 'Enter')]
                else:
                    interaction_keys = [INTERACTION_KEYS[key]]
            result = {'ok': False, 'pasted': False, 'submitted': False, 'pane_id': pid, 'request_id': request_id}
            # Keep the receipt even if a later step fails: retries must not paste twice.
            self.receipts[receipt_key] = {'time': now, 'fingerprint': fingerprint, 'result': result}
            if kind == 'raw':
                try:
                    await self.command('send-keys', '-t', pid, '-H', *(format(byte, '02x') for byte in text.encode('utf-8')))
                    result['submitted'] = True
                except web.HTTPException:
                    result['error'] = '직접 입력 결과를 확인할 수 없어요. 화면을 확인해 주세요.'
            elif kind=='agent_command' and payload['command'] in {'mode','login-key'}:
                await self.command('send-keys','-t',pid,'BTab' if payload['command']=='mode' else INTERACTION_KEYS[key])
                result['submitted']=True
            elif kind in {'text', 'agent_command', 'async_question'} or answer is not None:
                buffer = 'mobile-' + secrets.token_hex(12)
                try:
                    await self.command('load-buffer', '-b', buffer, '-', data=text.encode('utf-8'))
                    await self.command('paste-buffer', '-d', '-p', '-b', buffer, '-t', pid)
                    result['pasted'] = True
                    if async_identity:
                        self.async_answers[async_identity] = time.monotonic()
                    if submit:
                        await self.command('send-keys', '-t', pid, 'Enter')
                        result['submitted'] = True
                except web.HTTPException:
                    result['error'] = '일부 단계가 완료되지 않았어요. 화면에서 전송 결과를 확인해 주세요.'
                finally:
                    await self.command('delete-buffer', '-b', buffer, tolerate=True)
            else:
                try:
                    await self.command('send-keys', '-t', pid, *(interaction_keys if kind in {'interaction', 'send_now'} else [KEYS[key]]))
                    result['submitted'] = True
                except web.HTTPException:
                    result['error'] = '키 전송 결과를 확인할 수 없어요. 화면을 확인해 주세요.'
            needs_paste=kind in {'text','async_question'} or kind=='agent_command' and payload['command'] not in {'mode','login-key'} or answer is not None
            result['ok'] = result['pasted'] and (not submit or result['submitted']) if needs_paste else result['submitted']
            self.snapshots.pop(pid, None)
            return dict(result, duplicate=False)
