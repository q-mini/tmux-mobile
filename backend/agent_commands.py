"""Only open a native command menu at a confirmed empty, idle CLI prompt."""
import re
from .delivery import PROMPT, ghost_prompt, pending_input
from .interactions import ESCAPE, RULE, dialog


def model_command_ready(source, agent):
    if agent not in {'Claude', 'Codex'}:
        return False, 'Codex·Claude 화면에서 사용할 수 있어요.'
    if dialog(source):
        return False, '현재 선택 화면을 먼저 마치거나 닫아 주세요.'
    if pending_input(source, agent):
        return False, '대기 중인 입력을 먼저 처리해 주세요.'
    raw = source.splitlines()
    lines = [ESCAPE.sub('', line).rstrip() for line in raw]
    while lines and not lines[-1].strip():
        lines.pop()
    at = next((i for i in range(len(lines)-1, max(-1, len(lines)-16), -1) if PROMPT.match(lines[i])), None)
    if at is None:
        return False, 'CLI 입력 위치를 확인할 수 없어요. 원본 터미널을 확인해 주세요.'
    if PROMPT.match(lines[at])[1].strip() and not ghost_prompt(raw[at],hint_cursor=True):
        return False, '원본 터미널에 작성 중인 입력이 있어요. 그대로 보존했습니다.'
    footer = '\n'.join(lines[at+1:])
    known = re.search(r'\b(?:Opus|Sonnet|Haiku)\b|⏵|Not logged in|shift.tab to cycle', footer,re.I) if agent == 'Claude' else re.search(r'\b(?:gpt[- ]?\d|codex|o[134]\b)|for shortcuts|for agents', footer, re.I)
    if not known:
        return False, 'CLI 상태를 확인할 수 없어요. 원본 터미널을 확인해 주세요.'
    for row in lines[at+1:]:
        if RULE.fullmatch(row):
            break
        if row.strip() and not re.search(r'\b(?:gpt[- ]?\d|codex|o[134]\b)|for shortcuts|for agents', row, re.I):
            return False, '원본 터미널의 여러 줄 입력을 그대로 보존했습니다.'
    tail = '\n'.join(lines[max(0, at-10):at])
    if re.search(r'esc\s+to\s+interrupt|^\s*[✻✽✳✶✢✦*·•]\s*[^\n]*(?:…|\.\.\.)', tail, re.I | re.M):
        return False, '에이전트 작업이 끝난 뒤 모델을 선택해 주세요.'
    return True, ''


def claude_status(source):
    """Read live footer state; missing warnings do not establish authentication."""
    lines=ESCAPE.sub('',source).splitlines();tail='\n'.join(lines[-14:])
    mode=next((name for pattern,name in [(r'auto mode on','auto'),(r'accept edits on','accept-edits'),(r'bypass permissions on','bypass'),(r'plan mode on','plan'),(r'default mode|ask before edits','default')] if re.search(pattern,tail,re.I)),None)
    start=next((i for i in range(len(lines)-1,-1,-1) if re.search(r'^\s*(?:Select login method|How would you like to log in|Log in to Claude Code|Paste (?:the )?(?:authorization )?code|Browser didn.t open|Waiting for authentication)|https://(?:claude\.ai|console\.anthropic\.com|platform\.claude\.com)/oauth/',lines[i],re.I)),None)
    screen='\n'.join(lines[max(0,start-3):])[-14000:] if start is not None else ''
    links=[]
    for match in re.finditer(r'https://(?:claude\.ai|console\.anthropic\.com|platform\.claude\.com)/[^\s<>"\']+',screen):
        value=match[0];continuation=screen[match.end():].splitlines()
        if continuation and not continuation[0].strip():
            for row in continuation[1:]:
                part=row.strip()
                if not re.fullmatch(r'[A-Za-z0-9%_~:/?#@!$&()*+,;=.-]+',part) or not (len(part)>=40 or re.search(r'[?&=%]',part)):break
                value+=part
        if value not in links:links.append(value)
    return {'auth':'signed_out' if re.search(r'Not logged in\b',tail,re.I) else 'signed_in' if re.search(r'Login successful|Successfully logged in',tail,re.I) else 'unknown','mode':mode,'login_screen':screen,'login_links':links[:3]}
