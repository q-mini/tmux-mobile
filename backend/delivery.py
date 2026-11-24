"""Recognize live CLI input queues; never infer a queue merely from a busy agent."""
import re
from .interactions import ESCAPE, dialog

PROMPT = re.compile(r'^\s*[❯›>]\s*(.*)$')
KEYS = {'esc': 'Escape', 'escape': 'Escape', **{'f'+str(number): 'F'+str(number) for number in range(1, 13)}}
CLAUDE_HINT = re.compile(r'\s*Press up to (?:edit queued messages|select a queued message to edit|select a queued message, then Enter to edit it)(?:,? (?:or )?Enter to send (?:them (?:immediately|now)|now))?:?\s*', re.I)


def ghost_prompt(line, hint_cursor=False, queued=False):
    """Only an entirely dim native placeholder is empty; typed prefixes are not."""
    match = PROMPT.match(ESCAPE.sub('', line))
    if not match:
        return False
    body_at, visible, previous, dim, found, inverse = match.start(1), 0, 0, False, False, False
    foreground = None
    for escape in [*ESCAPE.finditer(line), None]:
        segment = line[previous:escape.start() if escape else len(line)]
        body = segment[max(0, body_at-visible):]
        if body.strip():
            if not dim and not (queued and foreground in {37, 90, 246, 'gray'}) and not (hint_cursor and inverse and not found and len(body.strip()) == 1):
                return False
            found = True
        visible += len(segment)
        if escape is None:
            break
        code = escape.group()
        if code.startswith('\x1b[') and code.endswith('m'):
            values = code[2:-1].split(';')
            index = 0
            while index < len(values):
                value = values[index]
                if value in {'38', '48', '58'} and index+1 < len(values):
                    if value == '38':
                        if values[index+1] == '5' and index+2 < len(values):
                            foreground = int(values[index+2]) if values[index+2].isdigit() else None
                        elif values[index+1] == '2' and index+4 < len(values):
                            foreground = 'gray' if len(set(values[index+2:index+5])) == 1 else None
                    index += 5 if values[index+1] == '2' else 3
                    continue
                if value in {'', '0', '22'}:
                    dim = False
                elif value == '2':
                    dim = True
                if value in {'', '0', '27'}:
                    inverse = False
                elif value == '7':
                    inverse = True
                if value in {'', '0', '39'}:
                    foreground = None
                elif value.isdigit() and (30 <= int(value) <= 37 or 90 <= int(value) <= 97):
                    foreground = int(value)
                index += 1
        previous = escape.end()
    return found


def pending_input(source, agent=None):
    if dialog(source):
        return None
    raw = source.splitlines()
    lines = [ESCAPE.sub('', line).rstrip() for line in raw]
    while lines and not lines[-1].strip():
        lines.pop()
    if not lines:
        return None
    prompt_at = next((i for i in range(len(lines)-1, -1, -1) if PROMPT.match(lines[i])), None)
    if prompt_at is None:
        return None
    draft = PROMPT.match(lines[prompt_at])[1].strip()
    inline_hint = bool(CLAUDE_HINT.fullmatch(draft)) and ghost_prompt(raw[prompt_at], hint_cursor=True)
    # Both CLIs paint ghost suggestions dim. A typed prefix still blocks flushing.
    if draft and not inline_hint and not ghost_prompt(raw[prompt_at]):
        return None
    tail_start = max(0, len(lines)-12)
    tail = '\n'.join(lines[tail_start:])
    if agent in (None, 'Claude'):
        hint = prompt_at if inline_hint else next((i for i in range(len(lines)-1, tail_start-1, -1)
                     if CLAUDE_HINT.fullmatch(lines[i])), None)
        if hint is not None:
            # Queue entries use the same prompt glyph above the live empty input.
            entries = [i for i in range(prompt_at) if PROMPT.match(lines[i]) and PROMPT.match(lines[i])[1].strip()]
            if not entries:
                return None
            queued = []
            for index, start in enumerate(entries):
                stop = entries[index+1] if index+1 < len(entries) else prompt_at
                block = lines[start:stop]
                binding = next((i for i, line in enumerate(block) if re.fullmatch(r'\s*ctrl\+x ctrl\+s to send now\s*', line, re.I)), None)
                if binding is not None:
                    queued.append('\n'.join(block[:binding]).strip())
            if not queued:
                start = entries[-1]
                end = next((i for i in range(start+1, prompt_at) if not lines[i].strip() or re.match(r'^\s*[✻✽✳✶✢✦*·●]\s*.*(?:…|\.\.\.|tokens|esc to interrupt)', lines[i], re.I)), prompt_at)
                queued = ['\n'.join(lines[start:end]).strip()]
            elif inline_hint:
                # The installed CLI prints the send-now hint only under the last
                # queued item. Earlier queued items follow the last assistant row.
                assistant = next((i for i in range(prompt_at-1, -1, -1) if re.match(r'^\s*●(?:\s|$)', lines[i])), -1)
                active = [start for start in entries if start > assistant]
                styled, styles = [], ''
                for index, line in enumerate(raw[:prompt_at]):
                    if index in active and ghost_prompt(styles+line, queued=True):
                        styled.append(index)
                    styles += ''.join(match.group() for match in ESCAPE.finditer(line) if match.group().endswith('m'))
                if styled:
                    active = styled
                if active:
                    queued = []
                    for index, start in enumerate(active):
                        stop = active[index+1] if index+1 < len(active) else prompt_at
                        end = next((i for i in range(start+1, stop) if not lines[i].strip() or re.search(r'ctrl\+x ctrl\+s to send now', lines[i], re.I) or re.match(r'^\s*[✻✽✳✶✢✦*·]\s*.*(?:…|\.\.\.)', lines[i])), stop)
                        queued.append('\n'.join(lines[start:end]).strip())
            preview = '\n\n'.join(queued)
            keys = ['Enter'] if re.search(r'Enter to send', lines[hint], re.I) else ['C-x', 'C-s']
            return {'agent': 'Claude', 'preview': preview[:1200], 'keys': keys, 'hint': lines[hint].strip()}
    if agent in (None, 'Codex'):
        start = next((i for i in range(prompt_at-1, -1, -1) if re.match(r'^\s*[•·]?\s*(?:Messages to be submitted (?:after next tool call|at end of turn)|Queued follow-up inputs)\b', lines[i])), None)
        if start is not None:
            block = '\n'.join(lines[start:prompt_at])
            if not re.search(r'^\s*↳\s*\S', block, re.M):
                return None
            binding = re.search(r'\b(esc(?:ape)?|f\d{1,2})\s+to\s+interrupt(?:\s+and\s+send\s+immediately)?', block+'\n'+tail, re.I)
            key = KEYS.get(binding[1].lower()) if binding else None
            if not key:
                return None
            # Keep changing spinner clocks and model usage out of the queue identity.
            content = [line.strip() for line in lines[start:prompt_at] if not re.search(r'\b(?:Working|Thinking|Reasoning)\s*\(', line, re.I)]
            return {'agent': 'Codex', 'preview': '\n'.join(content)[:1200], 'keys': [key], 'hint': binding[0].lower()}
    return None
