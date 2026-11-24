"""Read foreground Claude history and confirmed Codex usage, read-only.

This module also runs over the configured host's SSH connection using stdlib only.
"""
import base64
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys
import time

UUID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}')
PAGE_BYTES = 2 * 1024 * 1024
PAGE_MESSAGES = 60
PROJECTION_VERSION = 10
MAX_MEDIA_BYTES = 32 * 1024 * 1024
MAX_RECORD_BYTES = 64 * 1024 * 1024


def question_data(value, call_id=''):
    """Normalize explicit user-question schemas; never infer actions from prose."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return None
    if not isinstance(value, dict):
        return None
    questions = []
    for index, raw in enumerate(value.get('questions', []) if isinstance(value.get('questions'), list) else []):
        if not isinstance(raw, dict) or len(questions) >= 20:
            continue
        prompt = raw.get('question') or raw.get('title') or raw.get('prompt')
        if not isinstance(prompt, str) or not prompt.strip():
            continue
        options = []
        for option in raw.get('options', []) if isinstance(raw.get('options'), list) else []:
            if isinstance(option, str):
                option = {'label': option}
            if not isinstance(option, dict) or not isinstance(option.get('label'), str) or len(options) >= 30:
                continue
            options.append({key: option[key][:limit] for key, limit in [('label', 1000), ('description', 4000), ('preview', 16000)]
                            if isinstance(option.get(key), str)})
        questions.append({'id': str(raw.get('id') or prompt)[:8000], 'prompt': prompt[:8000],
                          'header': str(raw.get('header') or '')[:200], 'multiple': bool(raw.get('multiSelect') or raw.get('multi_select') or raw.get('multiple')),
                          'options': options})
    answers = {}
    for key, answer in (value.get('answers') or {}).items() if isinstance(value.get('answers'), dict) else []:
        if isinstance(answer, dict):
            answer = answer.get('answers', [])
        if isinstance(answer, str):
            answer = [answer]
        if isinstance(answer, list):
            answers[str(key)[:8000]] = [item[:16000] for item in answer[:30] if isinstance(item, str)]
    if not questions and not answers:
        return None
    annotations = {str(key)[:8000]: {'preview': item['preview'][:16000]} for key, item in (value.get('annotations') or {}).items()
                   if isinstance(item, dict) and isinstance(item.get('preview'), str)} if isinstance(value.get('annotations'), dict) else {}
    return {'call_id': str(call_id), 'questions': questions, 'answers': answers, 'annotations': annotations,
            'state': 'answered' if answers else 'asked'}


def question_text(value):
    parts = []
    for question in value['questions']:
        parts.append(question['prompt'])
        for index, option in enumerate(question['options']):
            parts.append(f'{index + 1}. {option["label"]}' + ('\n' + option['description'] if option.get('description') else '')
                         + ('\n' + option['preview'] if option.get('preview') else ''))
        answer = value['answers'].get(question['id'], value['answers'].get(question['prompt'], []))
        if answer:
            parts.append('답변: ' + ', '.join(answer))
    return '\n\n'.join(parts)


def async_question_groups(messages):
    """Track explicit async asks and exact option replies, without guessing prose."""
    groups = {}
    for message in messages:
        value = message.get('question') or message.get('question_reply')
        if value:
            key = value.get('call_id')
            old = groups.get(key, {})
            groups[key] = {**old, **value, 'questions': value.get('questions') or old.get('questions', []),
                           'answers': {**old.get('answers', {}), **value.get('answers', {})}}
        if message.get('role') != 'user':
            continue
        text = message.get('plain', message.get('text', '')).strip()
        matches = []
        for group in groups.values():
            if not group.get('async'):
                continue
            for question in group['questions']:
                if group['answers'].get(question['id']):
                    continue
                for option in question['options']:
                    if text in {option['label'], question['prompt'] + '\n답변: ' + option['label']}:
                        matches.append((group, question, option['label']))
        if len(matches) == 1:
            group, question, label = matches[0]
            group['answers'][question['id']] = [label]
            group['state'] = 'answered' if all(group['answers'].get(q['id']) for q in group['questions']) else 'asked'
    return groups


def question_tool(name):
    return re.sub(r'[^a-z]', '', re.split(r'[./:]', str(name))[-1].lower()) in {
        'askuserquestion', 'askuser', 'askhuman', 'requestuserinput', 'requestuserinputasync'}


def image_sources(value):
    """Only explicit image blocks and image paths in visible tool records."""
    found, seen = [], set()

    def add(item):
        key = hashlib.sha256(json.dumps(item, sort_keys=True).encode()).hexdigest()
        if key not in seen and len(found) < 32:
            seen.add(key)
            found.append(item)

    def walk(node, depth=0):
        if depth > 12 or len(found) >= 32:
            return
        if isinstance(node, list):
            for child in node:
                walk(child, depth + 1)
        elif isinstance(node, dict):
            kind = node.get('type')
            source = node.get('source', {})
            if kind == 'image' and isinstance(source, dict) and source.get('type') == 'base64' and isinstance(source.get('data'), str):
                add({'data': source['data'], 'mime': source.get('media_type', 'image/png')})
                return
            if kind in {'image', 'output_image'} and isinstance(node.get('data'), str):
                add({'data': node['data'], 'mime': node.get('mimeType', node.get('media_type', 'image/png'))})
                return
            url = node.get('image_url')
            if isinstance(url, dict):
                url = url.get('url')
            if isinstance(url, str):
                walk(url, depth + 1)
            if kind == 'image_generation_call' and isinstance(node.get('result'), str):
                add({'data': node['result'], 'mime': 'image/png'})
            for key, child in node.items():
                if key in {'image_url', 'data', 'source'} or kind == 'image_generation_call' and key == 'result':
                    continue
                if key in {'content', 'output', 'result', 'images', 'structuredContent', 'text', 'path', 'file_path', 'filename', 'output_path', 'screenshot_path', 'url'}:
                    walk(child, depth + 1)
        elif isinstance(node, str):
            if node.startswith('data:image/'):
                match = re.fullmatch(r'data:(image/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)', node)
                if match:
                    add({'data': match[2], 'mime': match[1]})
                return
            if node.lstrip().startswith(('{', '[')):
                try:
                    parsed = json.loads(node)
                    if isinstance(parsed, (dict, list)):
                        walk(parsed, depth + 1)
                        return
                except ValueError:
                    pass
            if node.startswith(('/', '~/')) and '\n' not in node and len(node) < 4096 and re.search(r'\.(png|jpe?g|webp|gif|bmp|svg)$', node, re.I):
                add({'path': node})
                return
            for match in re.finditer(r'data:(image/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)', node):
                add({'data': match[2], 'mime': match[1]})
            # Quoted paths can contain spaces. Never fetch HTTP/file URLs or
            # accept a path supplied by the browser's media request itself.
            pattern = r'''["`']((?:/|~/)[^"`'\n]+?\.(?:png|jpe?g|webp|gif|bmp|svg))["`']|(?<![\w:/])((?:/|~/)[^\s<>"`'()]+?\.(?:png|jpe?g|webp|gif|bmp|svg))(?=$|[\s<>"`'(),;])'''
            for match in re.finditer(pattern, node, re.I):
                add({'path': match[1] or match[2]})

    walk(value)
    return found


def media_value(record, source, block=0):
    if source == 'codex':
        payload = record.get('payload', {})
        kind = payload.get('type')
        if record.get('type') != 'response_item':
            return None
        if kind in {'function_call_output', 'custom_tool_call_output'}:
            return payload.get('output')
        if kind == 'image_generation_call':
            return payload
    elif source == 'claude':
        blocks = record.get('message', {}).get('content', [])
        if not isinstance(blocks, list) or not 0 <= block < len(blocks):
            return None
        item = blocks[block]
        if not isinstance(item, dict):
            return None
        if item.get('type') == 'tool_result':
            return item.get('content')
    return None


def media_metadata(record, source, block=0):
    return [{'index': index, 'name': Path(item['path']).name if 'path' in item else f'이미지 {index + 1}'}
            for index, item in enumerate(image_sources(media_value(record, source, block)))]


def tool_text(value):
    """Keep text readable while image bytes travel through the lazy endpoint."""
    if isinstance(value, list):
        return '\n'.join(tool_text(item) for item in value if isinstance(item, dict) and item.get('type') in {'text', 'input_text', 'output_text'})
    if isinstance(value, dict):
        return tool_text(value.get('text', ''))
    if not isinstance(value, str):
        return ''
    if value.lstrip().startswith(('{', '[')):
        try:
            parsed = json.loads(value)
            if image_sources(parsed):
                def without_images(node):
                    if isinstance(node, dict):
                        if node.get('type') in {'image', 'input_image', 'output_image', 'image_generation_call'} or 'image_url' in node:
                            return '[이미지 결과]'
                        return {key: without_images(child) for key, child in node.items()}
                    if isinstance(node, list):
                        return [without_images(child) for child in node]
                    if isinstance(node, str) and node.startswith('data:image/'):
                        return '[이미지 결과]'
                    return node
                return json.dumps(without_images(parsed), ensure_ascii=False)
        except ValueError:
            pass
    return re.sub(r'data:image/[^;\s]+;base64,[A-Za-z0-9+/=]+', '[이미지 결과]', value)


def foreground_processes(pane, proc):
    """Only descendants in the pane's current foreground process group."""
    try:
        state = process_fields(int(pane['pid']), proc)
        tty, group = int(state[4]), int(state[5])
        pending, seen, result = [int(pane['pid'])], set(), []
        while pending and len(seen) < 256:
            pid = pending.pop()
            if pid in seen:
                continue
            seen.add(pid)
            try:
                path = proc / str(pid)
                pending.extend(map(int, (path / 'task' / str(pid) / 'children').read_text().split()))
                state = process_fields(pid, proc)
                if state[0] in {'T', 't', 'Z'} or tty and (int(state[4]) != tty or int(state[2]) != group):
                    continue
                args = [item.decode(errors='replace') for item in (path / 'cmdline').read_bytes().split(b'\0') if item]
                result.append((pid, args))
            except (OSError, ValueError, IndexError):
                continue
        return result
    except (OSError, ValueError, KeyError, IndexError):
        return []


def tail_records(path, limit=2 * 1024 * 1024):
    with path.open('rb') as stream:
        stream.seek(0, 2)
        end = stream.tell()
        start = max(0, end - limit)
        initial = start
        # A large tool image must not hide the utterance that binds Codex to
        # this pane. Include the preceding normal tail, still within a bound.
        while start and end - start < MAX_RECORD_BYTES:
            stream.seek(start - 1)
            if stream.read(1) == b'\n':
                break
            previous = max(0, start - limit)
            stream.seek(previous)
            prefix = stream.read(start - previous)
            boundary = prefix.rfind(b'\n')
            if boundary >= 0:
                start = previous + boundary + 1
                break
            start = previous
        if start < initial:
            start = max(0, start - limit)
        stream.seek(start)
        if start:
            stream.readline(MAX_RECORD_BYTES + 1)
        for line in stream:
            if not line.endswith(b'\n'):
                continue
            try:
                value = json.loads(line)
                payload = value.get('payload') if isinstance(value, dict) else None
                if isinstance(value, dict) and (value.get('type') == 'turn_context' or isinstance(payload, dict) and payload.get('type') in {'user_message', 'agent_message', 'message', 'turn_context', 'token_count'}):
                    yield value
            except (ValueError, UnicodeError):
                continue


def codex_text(record):
    payload = record.get('payload', {})
    if not isinstance(payload, dict):
        return ''
    if record.get('type') == 'event_msg' and payload.get('type') in {'user_message', 'agent_message'}:
        return payload.get('message', '')
    if record.get('type') == 'response_item' and payload.get('type') == 'message' and payload.get('role') in {'user', 'assistant'}:
        return '\n'.join(block.get('text', '') for block in payload.get('content', [])
                         if isinstance(block, dict) and block.get('type') in {'input_text', 'output_text', 'text'})
    return ''


def codex_usage(pane, home, proc, include_source=False):
    processes = foreground_processes(pane, proc)
    if not any(args and Path(args[0]).name == 'codex' for _, args in processes):
        return None
    # CODEX_THREAD_ID may be inherited from the agent that launched this CLI.
    # Never use cwd, newest-file order or that environment variable as identity.
    # Confirm a unique transcript against an actual visible, lengthy utterance.
    normalize = lambda text: re.sub(r'[\s`*•›]+', '', clean_text(text))
    screen = normalize(pane.get('screen', ''))
    if len(screen) < 80:
        return None
    root = home / '.codex'
    try:
        with sqlite3.connect('file:' + str(root / 'state_5.sqlite') + '?mode=ro', uri=True, timeout=.2) as db:
            candidates = db.execute("SELECT id, rollout_path, cwd FROM threads WHERE source IN ('cli','vscode','app-server') AND archived=0").fetchall()
        matches, utterances = [], {}
        for session, filename, cwd in candidates:
            if Path(cwd).resolve() != Path(pane.get('path', '')).resolve():
                continue
            path = Path(filename).resolve()
            if (root / 'sessions').resolve() not in path.parents or not path.is_file():
                continue
            records = list(tail_records(path))
            evidence, corpus = [], []
            for record in reversed(records):
                text = codex_text(record)
                if not isinstance(text, str):
                    continue
                text = normalize(text)
                corpus.append(text)
                # Sample within the message as a screen may start mid-utterance.
                evidence.extend((screen.rfind(text[at:at+80]), text[at:at+80]) for at in range(0, max(0, len(text)-79), 40) if text[at:at+80] in screen)
            utterances[session] = '\x00'.join(corpus)
            if evidence:
                matches.append((session, records, path))
                matches[-1] += (evidence,)
        if len(matches) > 1:
            # Shared instructions, quoted handoffs and copied requests are not
            # evidence of a particular CLI. Bind to the most recent exclusive
            # visible utterance; never fall back to newest file or cwd alone.
            ranked = []
            for match in matches:
                unique = [at for at, snippet in match[3] if not any(snippet in text for sid,text in utterances.items() if sid != match[0])]
                if unique:
                    ranked.append((max(unique), match))
            ranked.sort(key=lambda item:item[0], reverse=True)
            matches = [ranked[0][1]] if ranked and (len(ranked)==1 or ranked[0][0] >= ranked[1][0]+80) else []
        if len(matches) != 1:
            return None
        session, records, path, _ = matches[0]
        usage, context = None, {}
        for record in records:
            payload = record.get('payload', {})
            if not isinstance(payload, dict):
                continue
            if record.get('type') == 'turn_context' and isinstance(payload, dict):
                context = payload
            if record.get('type') == 'event_msg' and payload.get('type') == 'token_count':
                if payload.get('info') is not None:
                    usage = payload
                elif usage is not None and payload.get('rate_limits') is not None:
                    usage = dict(usage, rate_limits=payload['rate_limits'])
        if not context.get('model'):
            # A busy turn can push its turn_context outside the bounded tail.
            # Read settings for the already confirmed ID, never a nearby thread.
            try:
                with sqlite3.connect('file:' + str(root / 'state_5.sqlite') + '?mode=ro', uri=True, timeout=.2) as db:
                    saved = db.execute('SELECT model, reasoning_effort, sandbox_policy FROM threads WHERE id=?', (session,)).fetchone()
                if saved:
                    context = {'model': saved[0], 'effort': saved[1], 'sandbox_policy': json.loads(saved[2] or '{}')}
            except (sqlite3.Error, ValueError, TypeError):
                pass
        info, limits = (usage or {}).get('info') or {}, (usage or {}).get('rate_limits') or {}
        total, last = info.get('total_token_usage') or {}, info.get('last_token_usage') or {}
        window, occupied = info.get('model_context_window'), last.get('total_tokens')
        remaining = lambda used: {'value': round(max(0, min(100, 100 - float(used))), 1), 'remaining': True}
        status = {'model': context.get('model') or 'Codex', 'reasoning': context.get('effort') or '',
                  'context': remaining(100 * occupied / window) if isinstance(window, (int, float)) and window > 0 and isinstance(occupied, (int, float)) else None,
                  'weekly': None, 'primary': None, 'tokens': '', 'access': '', 'hint': '',
                  'total_tokens': total.get('total_tokens'), 'input_tokens': total.get('input_tokens'),
                  'cached_input_tokens': total.get('cached_input_tokens'), 'output_tokens': total.get('output_tokens')}
        count = total.get('total_tokens')
        if isinstance(count, (int, float)):
            divisor, suffix = (1e9, 'B') if count >= 1e9 else (1e6, 'M') if count >= 1e6 else (1e3, 'K') if count >= 1e3 else (1, '')
            status['tokens'] = (f'{count / divisor:.2f}'.rstrip('0').rstrip('.') if divisor > 1 else str(count)) + suffix
        policy = context.get('sandbox_policy') or {}
        status['access'] = {'danger-full-access': 'Full Access', 'read-only': 'Read-only', 'workspace-write': 'Workspace write'}.get(policy.get('type'), '')
        for period in ('primary', 'secondary'):
            value = limits.get(period)
            if not isinstance(value, dict) or not isinstance(value.get('used_percent'), (int, float)):
                continue
            if value.get('window_minutes') == 10080:
                status['weekly'] = remaining(value['used_percent'])
            elif period == 'primary':
                status['primary'] = {**remaining(value['used_percent']), 'minutes': value.get('window_minutes')}
        return {'source': 'codex', 'status_only': True, 'session_id': session,
                'usage_status': status, 'changed_at': path.stat().st_mtime,
                **({'_path': path} if include_source else {})}
    except (OSError, ValueError, TypeError, sqlite3.Error):
        return None


def task_notification(text):
    """Recognize a complete native task envelope, never a quote or fenced example."""
    return bool(re.fullmatch(r'\s*(?:<task-notification>[\s\S]*?</task-notification>\s*)+', text)
                and re.search(r'<task-id>[^<]+</task-id>', text)
                and re.search(r'<(?:summary|event)>[\s\S]*?</(?:summary|event)>', text))


def process_fields(pid, proc):
    return (proc / str(pid) / 'stat').read_text().rpartition(') ')[2].split()


def process(pid, proc):
    fields = process_fields(pid, proc)
    return int(fields[1]), fields[19]


def depth(pid, ancestor, proc):
    for distance in range(40):
        if pid == ancestor:
            return distance
        if pid <= 1:
            break
        pid, _ = process(pid, proc)
    return None


def session_file(pane, home=None, proc=None, pending=False):
    home, proc = Path(home or Path.home()), Path(proc or '/proc')
    root = home / '.claude'
    if not pane.get('pid') or not re.fullmatch(r'%\d+', pane.get('id', '')):
        return None
    try:
        pane_state = process_fields(int(pane['pid']), proc)
        tty, foreground = int(pane_state[4]), int(pane_state[5])
    except (OSError, ValueError, IndexError):
        return None
    matches = []
    for path in (root / 'sessions').glob('*.json'):
        try:
            record = json.loads(path.read_text())
            pid = int(record['pid'])
            state = process_fields(pid, proc)
            if path.stem != str(pid) or str(record['procStart']) != state[19]:
                continue  # A stale PID file must never select a different conversation.
            if tty and foreground > 0 and (int(state[4]) != tty or int(state[2]) != foreground):
                continue  # Suspended/background CLIs in this shell do not own its visible terminal.
            distance = depth(pid, int(pane['pid']), proc)
            if distance is None or not UUID.fullmatch(record.get('sessionId', '')):
                continue
            if record.get('tmux') and not record['tmux'].endswith('.' + pane['id']):
                continue
            matches.append((distance, record))
        except (OSError, ValueError, KeyError, TypeError, IndexError):
            continue
    if not matches:
        return None
    matches.sort(key=lambda item: item[0])
    projects = root / 'projects'
    sources = set()
    for distance, record in matches:
        if distance != matches[0][0]:
            break
        slug = re.sub(r'[^a-zA-Z0-9]', '-', record.get('cwd', ''))
        expected = projects / slug / (record['sessionId'] + '.jsonl')
        paths = [expected] if expected.is_file() else list(projects.glob('*/' + record['sessionId'] + '.jsonl'))
        # A newly started, verified foreground CLI registers its identity before
        # the first message creates its transcript. Do not guess an older log.
        if pending and not paths and not expected.exists():
            paths = [expected]
        paths = [path.resolve() for path in paths if (path.is_file() or pending and not path.exists()) and projects.resolve() in path.resolve().parents]
        if len(paths) != 1:
            return None
        sources.add((paths[0], record['sessionId']))
    # Duplicate registrations of the same exact transcript are one source. Distinct
    # sources remain ambiguous; never choose one by cwd, recency or PID ordering.
    return next(iter(sources)) if len(sources) == 1 else None


def clean_text(text):
    return re.sub(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))', '', text).replace('\x00', '')


def with_user_attachments(item):
    """Expose attachment IDs, never filesystem URLs or cleanup instructions."""
    if item.get('role') != 'user':
        return item
    text = item['text']
    # Claude Code wraps pasted input in <pasted_content id="…"> … </pasted_content id="…">; show only what was pasted.
    unwrapped = re.sub(r'</?pasted_content(?: id="[^"]*")?>\n?', '', text)
    if unwrapped != text:
        text = unwrapped.strip()
        item = dict(item, text=text, plain=clean_text(text))
    match = re.search(r'(?:^|\n\n)첨부 파일 \(이 서버에 저장(?:된 임시 원본|됨)\):\n', text)
    if not match:
        return item
    attachments = []
    for line in text[match.end():].splitlines():
        if not line.startswith('- '):
            if line.strip():
                break
            continue
        try:
            filename = json.loads(line[2:])
            path = re.search(r'/attachments/([a-f0-9]{32})/([^/]+)$', filename)
            if path:
                attachments.append({'id': path[1], 'name': path[2], 'url': '/api/attachments/' + path[1] + '/preview'})
        except (ValueError, TypeError):
            continue
    if attachments:
        item = dict(item, text=text[:match.start()].rstrip(), attachments=attachments)
        item['plain'] = clean_text(item['text'])
    return item


def codex_visible(record, offset, session):
    # Response items are canonical. Mirrored item_completed events duplicate
    # them and also contain hidden reasoning, so never render those envelopes.
    if record.get('type') != 'response_item':
        return []
    payload = record.get('payload')
    if not isinstance(payload, dict):
        return []
    kind, role, title = payload.get('type'), '', ''
    question, reply = None, None
    if kind == 'message' and payload.get('role') in {'user', 'assistant'}:
        role = payload['role']
        meta = payload.get('internal_chat_message_metadata_passthrough') or {}
        provenance = meta.get('content_item_kinds')
        if role == 'user' and provenance and not any(str(value).startswith('user.') for value in provenance):
            return []
        content = '\n'.join(block.get('text', '') for block in payload.get('content', [])
                            if isinstance(block, dict) and block.get('type') in {'input_text', 'output_text', 'text'})
    elif kind in {'function_call', 'custom_tool_call'}:
        role, title = 'activity', str(payload.get('name') or '도구 실행')
        content = payload.get('input') if kind == 'custom_tool_call' else payload.get('arguments', '')
        if question_tool(title):
            question = question_data(content, payload.get('call_id') or payload.get('id') or offset)
            if question and question['questions']:
                if re.sub(r'[^a-z]', '', title.lower()).endswith('requestuserinputasync'):
                    question['async'] = True
                role, title, content = 'question', '질문', question_text(question)
        if kind == 'function_call':
            try:
                arguments = json.loads(content)
                if isinstance(arguments, dict):
                    content = '\n'.join(str(arguments[key]) for key in ['description', 'cmd', 'command', 'file_path', 'path', 'pattern', 'query'] if key in arguments) or content
            except (ValueError, TypeError):
                pass
    elif kind in {'function_call_output', 'custom_tool_call_output'}:
        role, title, content = 'activity', '실행 결과', payload.get('output', '')
        reply = question_data(content, payload.get('call_id') or payload.get('id') or '')
        if reply and reply['questions']:
            question, reply = reply, None
            role, title, content = 'question', '질문', question_text(question)
        content = tool_text(content)
    elif kind == 'image_generation_call':
        role, title, content = 'activity', '이미지 생성', ''
    else:
        return []
    media = media_metadata(record, 'codex') if role == 'activity' else []
    if media and not content:
        content = '이미지 결과를 펼쳐 볼 수 있어요.'
    if not isinstance(content, str) or not content.strip():
        return []
    limit = 64000 if role == 'activity' else 512000
    if role == 'activity':
        content = re.sub(r'data:image/[^;\s]+;base64,[A-Za-z0-9+/=]+', '[이미지 결과]', content)
    content = content[:limit] + ('\n… 긴 기록의 일부를 표시했어요.' if len(content) > limit else '')
    item = {'id': str(payload.get('id') or payload.get('call_id') or offset), 'role': role,
            'text': content, 'plain': clean_text(content), 'title': title, 'offset': offset, 'block': 0}
    if kind in {'function_call_output', 'custom_tool_call_output'}:
        item['id'] = 'result:' + item['id'] + ':' + str(offset)
    if media:
        item['media'] = media
    if question:
        item['question'] = question
    if reply:
        item['question_reply'] = reply
    return [with_user_attachments(item)]


def visible(record, offset, session):
    if record.get('sessionId') != session or record.get('isSidechain') or record.get('isMeta') or record.get('isCompactSummary'):
        return []
    kind = record.get('type')
    if kind == 'attachment':
        attachment = record.get('attachment')
        if (isinstance(attachment, dict) and attachment.get('type') == 'queued_command'
                and attachment.get('commandMode') == 'prompt' and attachment.get('humanTurn') is True
                and isinstance(attachment.get('origin'), dict) and attachment['origin'].get('kind') == 'human'
                and isinstance(attachment.get('prompt'), str) and attachment['prompt'].strip()):
            text = attachment['prompt'][:512000]
            identity = attachment.get('delivery_id') or attachment.get('source_uuid') or record.get('uuid') or offset
            return [with_user_attachments({'id': 'queued:' + str(identity), 'role': 'user', 'text': text, 'plain': clean_text(text),
                     'title': '', 'offset': offset, 'block': 0})]
        return []
    if kind not in {'user', 'assistant'}:
        return []
    message = record.get('message', {})
    blocks = message.get('content', [])
    # Native local settings actions are saved with role=user even when opened
    # by a UI control. Their CLI envelope is not a human chat message.
    if kind == 'user' and record.get('entrypoint') == 'cli' and record.get('promptId') and isinstance(blocks, str):
        if re.fullmatch(r'\s*<command-name>[^<]+</command-name>\s*<command-message>[\s\S]*?</command-message>\s*<command-args>[\s\S]*?</command-args>\s*', blocks):
            return []
        local = re.fullmatch(r'\s*<local-command-stdout>([\s\S]*?)</local-command-stdout>\s*', blocks)
        if local:
            content = clean_text(local[1]).replace('`', '').strip()
            return [{'id': str(record.get('uuid') or offset) + ':local', 'role': 'status',
                     'text': content, 'plain': content, 'title': '', 'offset': offset, 'block': 0}] if content else []
    if isinstance(blocks, str):
        blocks = [{'type': 'text', 'text': blocks}]
    if not isinstance(blocks, list):
        return []
    items = []
    for index, block in enumerate(blocks):
        if not isinstance(block, dict):
            continue
        block_type, role, title = block.get('type'), kind, ''
        question, reply = None, None
        if block_type == 'text':
            content = block.get('text', '')
            # Claude saves queued background events with role=user as well. The
            # native provenance flag distinguishes these from actual typed XML.
            if kind == 'user' and isinstance(content, str) and (record.get('queueTranscriptOnly')
                    or (record.get('queueSkipAttachments') and task_notification(clean_text(content)))):
                role, title = 'activity', '자동 알림'
        elif block_type == 'tool_use':
            role, title = 'activity', str(block.get('name', '실행'))
            arguments = block.get('input', {})
            if not isinstance(arguments, dict):
                arguments = {}
            content = '\n'.join(str(arguments[key]) for key in ['description', 'command', 'file_path', 'path', 'pattern', 'query'] if key in arguments)
            if question_tool(title):
                question = question_data(arguments, block.get('id') or str(offset) + ':' + str(index))
                if question and question['questions']:
                    role, title, content = 'question', '질문', question_text(question)
        elif block_type == 'tool_result':
            role, title = 'activity', '실행 결과'
            content = tool_text(block.get('content', ''))
            result = record.get('toolUseResult')
            if isinstance(result, dict) and not block.get('is_error') and isinstance(result.get('structuredPatch'), list):
                patch = []
                for hunk in result['structuredPatch'][:100]:
                    if not isinstance(hunk, dict) or not isinstance(hunk.get('lines'), list):
                        continue
                    if not all(type(hunk.get(key)) is int for key in ['oldStart','oldLines','newStart','newLines']):
                        continue
                    patch.append(f"@@ -{hunk['oldStart']},{hunk['oldLines']} +{hunk['newStart']},{hunk['newLines']} @@")
                    patch.extend(line[:16000] for line in hunk['lines'][:2000] if isinstance(line,str))
                if patch:
                    filename = str(result.get('filePath') or '')[:1000]
                    content = (filename+'\n' if filename else '')+'\n'.join(patch)
                    title = '수정 결과'+(' · '+Path(filename).name if filename else '')
            reply = question_data(record.get('toolUseResult'), block.get('tool_use_id', '')) or question_data(content, block.get('tool_use_id', ''))
            if reply and reply['questions']:
                question, reply = reply, None
                role, title, content = 'question', '질문', question_text(question)
        elif block_type in {'image', 'document'}:
            content = '📎 ' + str(block.get('title') or ('이미지' if block_type == 'image' else '문서'))
        else:
            continue  # Hidden reasoning, signatures and binary attachment payloads are not UI messages.
        media = media_metadata(record, 'claude', index) if role == 'activity' else []
        if media and not content:
            content = '이미지 결과를 펼쳐 볼 수 있어요.'
        if not isinstance(content, str) or not content.strip():
            continue
        truncated = len(content) > (64000 if role == 'activity' else 512000)
        content = content[:64000 if role == 'activity' else 512000]
        if truncated:
            content += '\n… 긴 기록의 일부를 표시했어요.'
        items.append(with_user_attachments({'id': str(record.get('uuid') or message.get('id') or offset) + ':' + str(index),
                      'role': role, 'text': content, 'plain': clean_text(content), 'title': title, 'offset': offset, 'block': index,
                      **({'media': media} if media else {}), **({'question': question} if question else {}),
                      **({'question_reply': reply} if reply else {})}))
    return items


def image_mime(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    if data.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg'
    if data.startswith((b'GIF87a', b'GIF89a')):
        return 'image/gif'
    if data.startswith(b'RIFF') and data[8:12] == b'WEBP':
        return 'image/webp'
    if data.startswith(b'BM'):
        return 'image/bmp'
    if re.match(br'\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]', data[:4096]):
        return 'image/svg+xml'
    raise ValueError('지원하는 이미지 형식이 아니에요.')


def bound_media(path, session, source, pane, ref, home):
    match = re.fullmatch(r'(claude|codex):([0-9a-f-]{36}):(\d+):(\d+):(\d+):(\d+)', ref)
    stat = path.stat()
    if not match or match[1] != source or match[2] != session or int(match[3]) != stat.st_ino:
        raise ValueError('이미지의 대화 세션이 바뀌었어요. 작업 보기를 새로고침해 주세요.')
    offset, block, index = map(int, match.groups()[3:])
    with path.open('rb') as stream:
        if offset:
            stream.seek(offset - 1)
            if stream.read(1) != b'\n':
                raise ValueError('잘못된 이미지 위치예요.')
        stream.seek(offset)
        raw = stream.readline(MAX_RECORD_BYTES + 1)
    if len(raw) > MAX_RECORD_BYTES or not raw.endswith(b'\n'):
        raise ValueError('이미지 기록을 읽을 수 없어요.')
    record = json.loads(raw)
    projection = visible if source == 'claude' else codex_visible
    if not any(item.get('block') == block and item.get('media') for item in projection(record, offset, session)):
        raise ValueError('표시 가능한 도구 이미지가 아니에요.')
    images = image_sources(media_value(record, source, block))
    if not 0 <= index < len(images):
        raise ValueError('이미지를 찾을 수 없어요.')
    item = images[index]
    if 'data' in item:
        if len(item['data']) > MAX_MEDIA_BYTES * 4 // 3 + 4096:
            raise ValueError('이미지가 너무 커요.')
        data = base64.b64decode(item['data'], validate=True)
    else:
        name = item['path']
        target = (home / name[2:] if name.startswith('~/') else Path(name)).resolve()
        roots = [home.resolve(), Path('/tmp'), Path('/var/tmp')]
        if pane.get('path'):
            roots.append(Path(pane['path']).resolve())
        if not any(target == root or root in target.parents for root in roots) or not target.is_file():
            raise ValueError('원본 이미지가 없거나 읽을 수 없어요.')
        with target.open('rb') as stream:
            data = stream.read(MAX_MEDIA_BYTES + 1)
    if len(data) > MAX_MEDIA_BYTES:
        raise ValueError('이미지가 너무 커요.')
    return {'mime': image_mime(data), 'data': base64.b64encode(data).decode('ascii')}


def read_conversation(pane, before='', known='', home=None, proc=None, media=''):
    home, proc = Path(home or Path.home()), Path(proc or '/proc')
    selected = session_file(pane, home, proc, pending=True)
    source = 'claude'
    usage = None
    if selected is None:
        usage = codex_usage(pane, home, proc, include_source=True)
        if usage is None:
            if media:
                raise ValueError('이미지의 대화 세션을 확인할 수 없어요.')
            return {'source': None}
        selected, source = (usage.pop('_path'), usage['session_id']), 'codex'
    path, session = selected
    if source == 'claude' and not path.is_file():
        if media:
            raise ValueError('아직 저장된 대화 첨부가 없어요.')
        version = hashlib.sha256(f'{PROJECTION_VERSION}:{session}:pending'.encode()).hexdigest()[:24]
        return {'source': source, 'session_id': session, 'version': version,
                'changed': version != known, 'changed_at': time.time(),
                'messages': [], 'text': '', 'has_more': False, 'before': '', 'reset': bool(before)}
    if media:
        return bound_media(path, session, source, pane, media, home)
    stat = path.stat()
    version = hashlib.sha256(f'{PROJECTION_VERSION}:{session}:{stat.st_ino}:{stat.st_size}:{stat.st_mtime_ns}'.encode()).hexdigest()[:24]
    base = {'source': source, 'session_id': session, 'version': version, 'changed_at': stat.st_mtime}
    if usage:
        base['usage_status'] = usage['usage_status']
    if not before and version == known:
        return {**base, 'changed': False}
    end, reset = stat.st_size, False
    if before:
        match = re.fullmatch(r'([0-9a-f-]{36}):(\d+):(\d+)', before)
        if not match:
            raise ValueError('잘못된 대화 기록 위치예요.')
        if match[1] != session or int(match[2]) != stat.st_ino or int(match[3]) > stat.st_size:
            reset = True
        else:
            end = int(match[3])
    start = max(0, end - PAGE_BYTES)
    with path.open('rb') as stream:
        # An image's JSON line can exceed a normal history page. Extend only
        # the first partial record, within a fixed bound, rather than dropping it.
        while start and end - start < MAX_RECORD_BYTES:
            stream.seek(start - 1)
            if stream.read(1) == b'\n':
                break
            previous = max(0, start - PAGE_BYTES)
            stream.seek(previous)
            prefix = stream.read(start - previous)
            boundary = prefix.rfind(b'\n')
            if boundary >= 0:
                start = previous + boundary + 1
                break
            start = previous
        stream.seek(start)
        data = stream.read(end - start)
        at_boundary = not start
        if start:
            stream.seek(start - 1)
            at_boundary = stream.read(1) == b'\n'
    if start and not at_boundary:
        boundary = data.find(b'\n')
        if boundary >= 0:
            start += boundary + 1
            data = data[boundary + 1:]
        else:
            return {**base, 'changed': True, 'messages': [], 'before': f'{session}:{stat.st_ino}:{start}', 'has_more': start > 0, 'reset': reset}
    # Writers may be halfway through their last JSON line. Read it on the next poll.
    if data and not data.endswith(b'\n'):
        data = data[:data.rfind(b'\n') + 1]
    rows, offset = [], start
    for line in data.splitlines(keepends=True):
        rows.append((offset, line))
        offset += len(line)
    messages, cursor = [], start
    for offset, raw in reversed(rows):
        try:
            record = json.loads(raw)
        except (ValueError, UnicodeError):
            continue
        if not isinstance(record, dict):
            continue
        projection = {'claude': visible, 'codex': codex_visible}[source]
        values = projection(record, offset, session)
        for item in values:
            for image in item.get('media', []):
                image['ref'] = f'{source}:{session}:{stat.st_ino}:{offset}:{item["block"]}:{image["index"]}'
                image['id'] = hashlib.sha256(image['ref'].encode()).hexdigest()[:24]
        if values:
            messages[0:0] = values
            cursor = offset
            if len(messages) >= PAGE_MESSAGES:
                break
    else:
        cursor = start
    groups = async_question_groups(messages)
    for item in messages:
        if item.get('question', {}).get('async'):
            item['question'] = groups[item['question']['call_id']]
    return {**base, 'changed': True, 'messages': messages, 'before': f'{session}:{stat.st_ino}:{cursor}' if cursor else '',
            'has_more': cursor > 0, 'reset': reset}


if __name__ == '__main__':
    request = json.load(sys.stdin)
    try:
        print(json.dumps(read_conversation(request['pane'], request.get('before', ''), request.get('known', ''), media=request.get('media', '')), ensure_ascii=False))
    except (ValueError, OSError) as error:
        if not request.get('media'):
            raise
        print(json.dumps({'media_error': '원본 이미지가 없거나 대화 세션이 바뀌었어요.'}, ensure_ascii=False))
