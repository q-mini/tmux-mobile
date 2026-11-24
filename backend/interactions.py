"""Recognize a currently visible terminal choice dialog, never saved chat text."""
import re

ESCAPE = re.compile(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-2A-Z]|[@-_])')
CHECKBOX = r'(?:\[[ xX]\]|[☐☑☒◻◼□■✔✓])'
OPTION = re.compile(r'^\s*[↑↓]?\s*(?P<active>[❯›>])?\s*(?P<check>' + CHECKBOX + r')?\s*(?P<number>\d{1,2})[.)]\s+(?P<label>\S.*)$')
RULE = re.compile(r'^\s*[-─━═_–—=]{3,}\s*$')
MENU_FOOTER = re.compile(r'^\s*enter\s+(?:to\s+)?(?:select|default)\s*[·•|]\s*(?:s\s+session\s*[·•|]\s*)?esc\s+(?:to\s+)?back\s*$', re.I)
CONFIRM_TITLE = re.compile(r'^\s*(?:Do you want to .+|Would you like to (?:proceed|continue)[^?]*)\?\s*$', re.I)
CONFIRM_START = re.compile(r'^\s*(?:Do you want to\b|Would you like to\b)', re.I)
CONFIRM_OPTION = re.compile(r'^\s*(?P<active>[❯›>])?\s*(?:(?P<number>\d{1,2})[.)]\s+)?(?P<label>(?:Yes|No)\b.*)$', re.I)
CONFIRM_HINT = re.compile(r'^\s*(?:(?:press\s+)?(?:enter|esc(?:ape)?|tab|shift\+tab|ctrl\+[a-z]|↑|↓|←|→|arrow keys)\b.*|[·•|]\s*.*)$', re.I)


def native_model_picker(lines, positions=False):
    """Claude's compact model menu and horizontal effort picker."""
    at=next((i for i in range(len(lines)-1,-1,-1) if lines[i].strip() in {'Select model','Effort'}),None)
    if at is None:return None
    before=next((row for row in reversed(lines[:at]) if row.strip()),'')
    # Newer Claude Code draws the picker's top edge with upper-block characters.
    if before and not RULE.fullmatch(before) and not re.fullmatch(r'\s*▔{3,}\s*',before):return None
    # A fenced transcript is display data, never an actionable terminal menu.
    fences=0
    for row in lines[:at]:
        if re.match(r'^\s*(?:[•●⏺]\s+)?(?:`{3,}|~{3,})',row):fences+=1
    if fences%2:return None
    horizontal=lines[at].strip()=='Effort'
    footer_at=next((i for i in range(at+1,len(lines)) if re.search(r'Enter to (?:save|set as default|confirm)',lines[i],re.I) and re.search(r'Esc to cancel',lines[i],re.I)),None)
    if horizontal and footer_at is None:return None
    end=footer_at if footer_at is not None else len(lines)
    if footer_at is not None:
        tail=[row.strip() for row in lines[footer_at+1:] if row.strip() and not RULE.fullmatch(row)]
        if any(not re.match(r'^(?:[›❯>]\s*$|\w+@[\w.-]+:|(?:Opus|Sonnet|Haiku|Fable)\b|[⏵▸»])',row) for row in tail):return None
    footer=lines[footer_at].strip() if footer_at is not None else ''
    options=[];selected=None;effort=None;toggle=None
    if horizontal:
        levels_at=next((i for i in range(at+1,end) if re.search(r'\blow\s+medium\s+high\s+xhigh\s+max\b',lines[i],re.I)),None)
        if levels_at is None:return None
        levels=list(re.finditer(r'\b(low|medium|high|xhigh|max)\b',lines[levels_at],re.I))
        marker=next((re.search(r'[▲▴△^]',lines[i]) for i in range(levels_at-1,max(at,levels_at-3),-1) if re.search(r'[▲▴△^]',lines[i])),None)
        if marker is None:return None
        selected=min(range(len(levels)),key=lambda i:abs((levels[i].start()+levels[i].end()-1)/2-marker.start()))
        for i,match in enumerate(levels):
            option={'number':i+1,'label':match[1].lower(),'description':'','checked':False,'checkbox':False}
            if positions:option.update(row=levels_at,row_end=levels_at+1,col=match.start(),col_end=match.end())
            options.append(option)
        effort={'level':options[selected]['label'],'note':'default' if any('default effort' in row.lower() for row in lines[at:end]) else '', 'adjustable':True}
        ultra=next((re.search(r'Ultracode\s+(on|off)\b',row,re.I) for row in lines[at:end] if re.search(r'Ultracode\s+(on|off)\b',row,re.I)),None)
        if ultra:toggle={'label':'Ultracode','value':ultra[1].lower()=='on','key':'tab'}
    else:
        if not any('Your pick is the default for new sessions.' in row for row in lines[at+1:min(at+4,end)]):return None
        effort_row=next((i for i in range(at+1,end) if re.search(r'\b(?:Low|Medium|High|xHigh|Max|Ultra) effort.*[←↔]',lines[i],re.I)),None)
        if effort_row is None:return None
        if footer_at is None:
            tail=[row.strip() for row in lines[effort_row+1:] if row.strip() and not RULE.fullmatch(row)]
            if any(not re.match(r'^(?:[›❯>]\s*$|\w+@[\w.-]+:|(?:Opus|Sonnet|Haiku|Fable)\b|[⏵▸»])',row) for row in tail):return None
            end=effort_row+1
        for rowno in range(at+1,effort_row):
            row=lines[rowno];match=OPTION.match(row)
            more=re.fullmatch(r'\s*([❯›>])?\s*[▸▹▶►]\s+More models\s*',row)
            if not match and not more:continue
            number=int(match['number']) if match else len(options)+1
            if number!=len(options)+1:return None
            label=match['label'] if match else 'More models'
            parts=re.split(r'\s{2,}',label,maxsplit=1)
            if (match and match['active']) or (more and more[1]):
                if selected is not None:return None
                selected=len(options)
            option={'number':number,'label':parts[0],'description':parts[1] if len(parts)>1 else '', 'checked':False,'checkbox':False}
            if positions:option.update(row=rowno,row_end=rowno+1)
            options.append(option)
        match=re.search(r'\b(Low|Medium|High|xHigh|Max|Ultra) effort(?:\s+\(([^)]+)\))?',lines[effort_row],re.I)
        effort={'level':match[1],'note':match[2] or '', 'adjustable':True}
        if len(options)<2 or selected is None:return None
    return {'kind':'single','purpose':'model','title':'Effort' if horizontal else 'Select model','options':options,'selected':selected,'tabs':'','progress':'','text':'\n'.join(lines[at:end]).strip(),'footer':footer,'effort':effort,'select_key':'s' if re.search(r'\bs (?:to use|for) this session only',footer) else 'Enter',**({'navigation_axis':'horizontal'} if horizontal else {}),**({'toggle':toggle} if toggle else {})}


def confirmation(lines, positions=False):
    """Claude permission prompts can end at No (esc), without an Enter footer."""
    at, title_end, title = None, None, ''
    for first in range(len(lines)-1, -1, -1):
        if not CONFIRM_START.match(lines[first]):
            continue
        parts = []
        for last in range(first, min(first+20, len(lines))):
            row = lines[last]
            if not row.strip() or RULE.fullmatch(row) or CONFIRM_OPTION.fullmatch(row):
                break
            parts.append(row.strip())
            joined = ' '.join(parts)
            if CONFIRM_TITLE.fullmatch(joined):
                at, title_end, title = first, last+1, joined
                break
        if at is not None:
            break
    if at is None:
        return None
    options, selected, hint_at = [], None, None
    for row in range(title_end, len(lines)):
        text = lines[row]
        if not text.strip():
            continue
        if CONFIRM_HINT.fullmatch(text):
            if not options:
                return None
            hint_at = row if hint_at is None else hint_at
            continue
        if hint_at is not None:
            return None  # A prompt, reply or status after an old dialog is not live.
        match = CONFIRM_OPTION.fullmatch(text)
        if match:
            number = int(match['number']) if match['number'] else len(options)+1
            if number != len(options)+1:
                return None
            if match['active']:
                if selected is not None:
                    return None
                selected = len(options)
            options.append({'number': number,'label': match['label'],'description': '', 'checked': False,'checkbox': False})
            if positions:
                options[-1].update(row=row,row_end=row+1)
        elif options and re.match(r'^\s{2,}\S', text) and not re.match(r'^\s*(?:[❯›>]|[⏵✻✽✳✶✢✦]|(?:Opus|Sonnet|Haiku|GPT|Claude Code)\b|\w+@\w+)', text, re.I) and not RULE.fullmatch(text):
            options[-1]['description'] = (options[-1]['description']+' '+text.strip()).strip()[:2000]
            if positions:
                options[-1]['row_end']=row+1
        else:
            return None
    if not 2 <= len(options) <= 10 or selected is None or not options[0]['label'].lower().startswith('yes') or not options[-1]['label'].lower().startswith('no'):
        return None
    start = next((i+1 for i in range(at-1,-1,-1) if RULE.fullmatch(lines[i])),at)
    if start == at:
        start = next((i for i in range(at-1,max(-1,at-60),-1) if re.fullmatch(r'\s*(?:Bash command|(?:Read|Edit|Write|Create) file|Tool use|Permission request)\s*',lines[i],re.I)),at)
    # Only the current native request is actionable; quoted/fenced examples are not.
    fence = None
    for row in lines[:at]:
        match = re.match(r'^\s*(?:[•●⏺]\s+)?(`{3,}|~{3,})(.*)$',row)
        if match:
            if fence is None:
                fence = match[1]
            elif not match[2].strip() and match[1][0] == fence[0] and len(match[1]) >= len(fence):
                fence = None
    if fence is not None:
        return None
    context='\n'.join(lines[start:at]).strip()[-6000:]
    return {'kind':'single','purpose':'permission','title':title, 'context':context,
            'options':options,'selected':selected,'tabs':'','progress':'',
            'text':'\n'.join(lines[start:hint_at]).strip()[:10000],
            'footer':'\n'.join(lines[hint_at:]).strip()[:1000] if hint_at is not None else ''}


def workspace_trust(lines, positions=False):
    """Claude's startup trust chooser is unnumbered and puts No before Yes."""
    if not lines or not re.fullmatch(r'\s*Enter to confirm\s*[·•|]\s*Esc to cancel\s*', lines[-1], re.I):
        return None
    start = next((i for i in range(len(lines)-1, -1, -1) if lines[i].strip() == 'Accessing workspace:'), None)
    if start is None:
        return None
    # Do not turn a code sample or old quoted startup screen into live buttons.
    fence = None
    for row in lines[:start]:
        match = re.match(r'^\s*(?:[•●⏺]\s+)?(`{3,}|~{3,})(.*)$', row)
        if match:
            if fence is None:
                fence = match[1]
            elif not match[2].strip() and match[1][0] == fence[0] and len(match[1]) >= len(fence):
                fence = None
    if fence is not None:
        return None
    matches = []
    for row in range(start+1, len(lines)-1):
        match = re.fullmatch(r'\s*(?P<active>[❯›>])?\s*(?P<label>No, exit|Yes, I trust this folder)\s*', lines[row])
        if match:
            matches.append((row, match))
    if [match['label'] for _, match in matches] != ['No, exit', 'Yes, I trust this folder'] or sum(bool(match['active']) for _, match in matches) != 1:
        return None
    if any(line.strip() for line in lines[matches[-1][0]+1:-1]):
        return None
    context = '\n'.join(lines[start+1:matches[0][0]]).strip()
    if 'Claude Code' not in context or not re.search(r'^\s*(?:/|[A-Za-z]:[\\/])\S*', context, re.M):
        return None
    options = []
    for number, (row, match) in enumerate(matches, 1):
        item = {'number': number, 'label': match['label'], 'description': '', 'checked': False, 'checkbox': False}
        if positions:
            item.update(row=row, row_end=row+1)
        options.append(item)
    return {'kind': 'single', 'purpose': 'permission', 'permission_kind': 'workspace',
            'title': '이 폴더를 신뢰할까요?', 'context': context, 'options': options,
            'selected': next(i for i, (_, match) in enumerate(matches) if match['active']),
            'tabs': '', 'progress': '', 'text': '\n'.join(lines[start:-1]).strip()[:10000], 'footer': lines[-1].strip()}


def dialog(source, positions=False):
    lines = ESCAPE.sub('', source).replace('\x00', '').splitlines()
    lines = [line.rstrip() for line in lines]
    while lines and not lines[-1].strip():
        lines.pop()
    picker=native_model_picker(lines,positions)
    if picker is not None:return picker
    trust = workspace_trust(lines, positions)
    if trust is not None:
        return trust
    permission = confirmation(lines, positions)
    if permission is not None:
        return permission
    tabs_in_screen = next((i for i in range(len(lines) - 1, -1, -1) if ('Submit' in lines[i] and re.search(r'[☐☑☒✔✓]', lines[i])) or re.fullmatch(r'\s*(?:[☐☑☒✔✓]\s*)?\[\s+[^\]\n]+\s+\]\s*', lines[i]) or re.fullmatch(r'\s*[☐☑☒]\s+(?!\d+[.)])\S.*',lines[i])), None)
    tail = [OPTION.match(row) for row in lines[-2:]]
    # Claude's final review has numbered Submit/Cancel actions but no key footer.
    review = (tabs_in_screen is not None and 'Review your answers' in [row.strip() for row in lines]
              and 'Ready to submit your answers?' in [row.strip() for row in lines]
              and len(tail) == 2 and all(tail)
              and [match['label'].strip() for match in tail] == ['Submit answers', 'Cancel']
              and sum(bool(match['active']) for match in tail) == 1)
    footer = '\n'.join(lines[-4:])
    menu = bool(lines and MENU_FOOTER.fullmatch(lines[-1]))
    codex_at = next((i for i in range(len(lines) - 1, -1, -1) if re.fullmatch(r'\s*Question\s+\d+/\d+(?:\s+\([^\n]*\))?(?:\s*·.*)?\s*', lines[i], re.I)), None)
    codex = (codex_at is not None and re.search(r'enter\s+to\s+submit\s+answer', footer, re.I)
             and re.search(r'esc\s+to\s+interrupt', footer, re.I))
    if not review and not menu and not (re.search(r'Enter\s+to\s+(?:select|confirm|submit|accept|continue|set as default)', footer, re.I)
                           and (codex or re.search(r'Esc(?:ape)?\s+to\s+(?:cancel|exit|close)', footer, re.I))):
        return None
    footer_at = len(lines) if review else len(lines) - 1 if menu else next((i for i in range(max(0, len(lines) - 4), len(lines)) if re.search(r'Enter\s+to\s+', lines[i], re.I)), len(lines))
    if review:
        footer = ''
    selected_line = next((i for i in range(footer_at - 1, -1, -1) if (match := OPTION.match(lines[i])) and match['active']), None)
    if codex and selected_line is not None and selected_line <= codex_at:
        selected_line = None
    tabs_at = tabs_in_screen
    anchor = codex_at if codex else tabs_at if tabs_at is not None else selected_line
    if anchor is None:
        return None
    start = next((i + 1 for i in range(anchor - 1, -1, -1) if RULE.fullmatch(lines[i])), 0)
    if codex:
        start = codex_at + 1
    end = next((i for i in range((selected_line if selected_line is not None else anchor) + 1, footer_at) if RULE.fullmatch(lines[i])), footer_at)
    if codex and selected_line is None:
        end = next((i for i in range(start, end) if re.match(r'^\s*[›❯>]\s*', lines[i])), end)
    if menu:
        # Native Codex menus sit below scrollback without a separator. Take only
        # the final consecutive numbered list and its immediately preceding title.
        candidates = [(i, match) for i in range(footer_at) if (match := OPTION.match(lines[i]))]
        if not candidates:
            return None
        expected, first = int(candidates[-1][1]['number']), None
        for index, match in reversed(candidates):
            if int(match['number']) != expected:
                break
            if expected == 1:
                first = index
                break
            expected -= 1
        if first is None or selected_line is None or selected_line < first:
            return None
        start = next((i for i in range(first - 1, -1, -1) if lines[i].strip()), first)
        end = footer_at
    model_at = next((i for i in range(start, footer_at) if re.fullmatch(r'\s*(?:Select|Choose) (?:model|reasoning effort)\s*', lines[i], re.I)), None)
    if model_at is not None and not codex and tabs_at is None:
        start, end = model_at, footer_at
    block = lines[start:end]
    if not block:
        return None
    options, title, selected, effort, overflow = [], [], None, None, ''
    for offset, row in enumerate(block):
        if not row.strip() or row == (lines[tabs_at] if tabs_at is not None else None):
            continue
        effort_match = re.fullmatch(r'\s*[◐◑◒◓◔◕◖◗◉○●]?\s*(Low|Medium|High|xHigh|Extra|Max|Ultra)\s+effort(?:\s+\(([^)]+)\))?\s*[←↔].*', row, re.I)
        if model_at is not None and effort_match:
            effort = {'level': effort_match[1], 'note': effort_match[2] or '', 'adjustable': True}
            continue
        if model_at is not None and re.fullmatch(r'\s*(?:…|\.\.\.)\s*\+\d+\s+models?\s*', row):
            overflow = row.strip()
            continue
        match = OPTION.match(row)
        if match:
            label = match['label']
            label_parts = re.split(r'\s{2,}', label, maxsplit=1) if codex or menu or model_at is not None else [label]
            label = label_parts[0]
            checkbox = re.match(r'^(?:\[(?P<tick>[ xX])\]|(?P<mark>[☐☑☒◻◼□■✔✓]))\s*', label)
            checked = bool(checkbox and ((checkbox['tick'] or '').lower() == 'x' or checkbox['mark'] in {'☑', '☒', '◼', '✔', '✓'}))
            if match['check']:
                checked = match['check'] in {'[x]', '[X]', '☑', '☒', '◼', '■', '✔', '✓'}
            if checkbox:
                label = label[checkbox.end():]
            if match['active']:
                if selected is not None:
                    return None
                selected = len(options)
            options.append({'number': int(match['number']), 'label': label[:500], 'description': label_parts[1][:2000] if len(label_parts) > 1 else '', 'checked': checked, 'checkbox': bool(checkbox or match['check'])})
            if positions:
                if len(options) > 1:
                    options[-2]['row_end'] = start + offset
                options[-1].update(row=start+offset, row_end=start+offset+1)
        elif options:
            options[-1]['description'] = (options[-1]['description'] + ' ' + row.strip()).strip()[:2000]
            if positions:
                options[-1]['row_end'] = start+offset+1
        else:
            title.append(re.sub(r'^\s*[│┃]\s*', '', row))
    if len(options) > 30 or len({item['number'] for item in options}) != len(options):
        return None
    multi = bool(re.search(r'Space\s+(?:to\s+)?(?:select|toggle)', footer, re.I) or any(item['checkbox'] for item in options))
    kind = 'review' if review else 'input' if codex and not options else 'multi' if multi else 'single' if options else 'review'
    title_text = '\n'.join(title).strip()[:3000] or '선택한 답변을 확인해 주세요.'
    purpose = bool(not codex and tabs_at is None and re.search(r'(?:select|choose|change|switch|pick|current).{0,30}(?:model|reasoning|effort)|(?:model|reasoning|effort).{0,30}(?:select|choose|level)|^(?:Model|Reasoning effort)$|모델|추론 수준', title_text, re.I))
    custom = next((item['number'] for item in options if re.fullmatch(r'Type something\.?', item['label'], re.I)), None)
    chat = next((int(match['number']) for row in lines[end:footer_at] if (match := OPTION.match(row)) and match['label'].strip()=='Chat about this'), None)
    draft = ''
    if kind == 'input':
        draft = next((re.sub(r'^\s*[›❯>]\s*', '', row).strip() for row in lines[end:footer_at] if re.match(r'^\s*[›❯>]', row)), '')
    return {'kind': kind, 'title': title_text,
            'options': options, 'selected': selected, 'tabs': lines[tabs_at].strip() if tabs_at is not None else '',
            'text': '\n'.join(block).strip()[:10000], 'footer': footer.strip()[:1000],
            'progress': lines[codex_at].strip() if codex else '',
            **({'effort': effort} if effort else {}),
            **({'overflow': overflow} if overflow else {}),
            **({'custom_choice': custom} if custom is not None else {}),
            **({'chat_choice': chat} if chat is not None else {}),
            **({'input_empty': not draft} if kind == 'input' else {}),
            **({'purpose': 'model', 'select_key': 's' if re.search(r's to use this session only|\bs session\b', footer) else 'Enter'} if purpose else {})}
