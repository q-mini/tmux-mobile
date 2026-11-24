const qLangReader=globalThis.QI18n||{t:value=>value,html:value=>value,f:(key,values)=>key.replace(/\{(\d+)\}/g,(_,index)=>String(values[index]??'')),locale:'ko-KR'};
/* Read tmux SGR styles as data. Terminal output is always inserted as text. */
(function(root){
  'use strict';
  const palette=['#2e3436','#cc0000','#4e9a06','#c4a000','#3465a4','#75507b','#06989a','#d3d7cf','#555753','#ef2929','#8ae234','#fce94f','#729fcf','#ad7fa8','#34e2e2','#eeeeec'];
  const escapePattern=/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-2A-Z]|[@-_])/g;
  const node=(tag,className='')=>{const value=document.createElement(tag);value.className=className;return value;};
  function readableLightInk(color,background='#e8e8eb'){
    const rgb=value=>{if(/^#[\da-f]{6}$/i.test(value))return [1,3,5].map(at=>parseInt(value.slice(at,at+2),16));const match=value.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);return match?match.slice(1).map(Number):null;};
    const ink=rgb(color),paper=rgb(background);if(!ink||!paper)return color;
    const luminance=values=>values.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    const base=luminance(paper),contrast=values=>{const light=luminance(values);return (Math.max(base,light)+.05)/(Math.min(base,light)+.05);};
    if(contrast(ink)>=4.5)return color;
    for(let step=1;step<=20;step++){const adjusted=ink.map((v,i)=>Math.round(v+(24+[0,9,19][i]-v)*step/20));if(contrast(adjusted)>=4.5)return `rgb(${adjusted.join(',')})`;}
    return '#18212b';
  }
  function indexedColor(value){
    if(value<16)return palette[value];
    if(value>=232){const gray=8+(value-232)*10;return `rgb(${gray},${gray},${gray})`;}
    const levels=[0,95,135,175,215,255],index=value-16;
    return `rgb(${levels[Math.floor(index/36)]},${levels[Math.floor(index/6)%6]},${levels[index%6]})`;
  }
  function sgr(state,source){
    const params=source?source.replaceAll(':',';').split(';').map(value=>value===''?0:Number(value)):[0];
    for(let i=0;i<params.length;i++){
      const value=params[i];
      if(value===0){for(const key of Object.keys(state))delete state[key];}
      else if(value===1)state.bold=true;else if(value===2)state.dim=true;else if(value===3)state.italic=true;
      else if(value===4)state.underline=true;else if(value===7)state.inverse=true;else if(value===9)state.strike=true;
      else if(value===22){delete state.bold;delete state.dim;}else if(value===23)delete state.italic;
      else if(value===24)delete state.underline;else if(value===27)delete state.inverse;else if(value===29)delete state.strike;
      else if(value===39)delete state.fg;else if(value===49)delete state.bg;
      else if(value>=30&&value<=37)state.fg=palette[value-30];
      else if(value>=90&&value<=97)state.fg=palette[value-90+8];
      else if(value>=40&&value<=47)state.bg=palette[value-40];
      else if(value>=100&&value<=107)state.bg=palette[value-100+8];
      else if(value===38||value===48){
        const key=value===38?'fg':'bg',mode=params[++i];
        if(mode===5){const color=params[++i];if(Number.isInteger(color)&&color>=0&&color<=255)state[key]=indexedColor(color);}
        else if(mode===2){
          // Colon SGR may include an empty color-space field: 38:2::r:g:b.
          if(source.includes(':')&&params.length-i>=5&&params[i+1]===0)i++;
          const color=params.slice(i+1,i+4);i+=3;
          if(color.length===3&&color.every(v=>Number.isInteger(v)&&v>=0&&v<=255))state[key]=`rgb(${color.join(',')})`;
        }
      }
    }
  }
  function parseAnsi(source){
    const lines=[{text:'',runs:[]}],state={};let offset=0;
    const add=value=>{
      const chunks=value.replace(/\r/g,'').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'').split('\n');
      chunks.forEach((text,index)=>{
        if(index)lines.push({text:'',runs:[]});
        if(text){const line=lines.at(-1);line.text+=text;line.runs.push({text,style:{...state}});}
      });
    };
    for(const match of source.matchAll(escapePattern)){
      add(source.slice(offset,match.index));
      if(/^\x1b\[[\d:;]*m$/.test(match[0]))sgr(state,match[0].slice(2,-1));
      offset=match.index+match[0].length;
    }
    add(source.slice(offset));for(const line of lines)line.text=line.text.trimEnd();
    while(lines.length&&!lines.at(-1).text)lines.pop();return lines;
  }
  function appendStyled(target,line,start=0,end=line.text.length){
    let offset=0;
    for(const run of line.runs){
      const from=Math.max(start-offset,0),to=Math.min(end-offset,run.text.length);offset+=run.text.length;
      if(to<=from)continue;
      const text=run.text.slice(from,to),style=run.style;
      if(!Object.keys(style).length){target.append(document.createTextNode(text));continue;}
      const span=node('span','ansi-run');span.textContent=text;
      const fg=style.fg||'var(--reader-foreground)',bg=style.bg||'var(--reader-background)';
      if(style.fg||style.inverse){const foreground=style.inverse?bg:fg,lightForeground=style.inverse?(style.bg||'#f4f4f5'):(style.fg||'#17171b'),lightBackground=style.inverse?(style.fg||'#17171b'):(style.bg||'#e8e8eb');span.style.setProperty('--ansi-original-foreground',foreground);span.style.setProperty('--ansi-light-foreground',readableLightInk(lightForeground,lightBackground));span.style.color='var(--ansi-visible-foreground,var(--ansi-original-foreground))';}
      if(style.bg||style.inverse)span.style.backgroundColor=style.inverse?fg:bg;
      if(style.bold)span.style.fontWeight='700';if(style.dim)span.classList.add('ansi-dim');
      if(style.italic)span.style.fontStyle='italic';
      if(style.underline||style.strike)span.style.textDecoration=[style.underline?'underline':'',style.strike?'line-through':''].filter(Boolean).join(' ');
      target.append(span);
    }
  }
  function appendInline(target,line,start=0,end=line.text.length){
    let offset=start;
    for(const match of line.text.slice(start,end).matchAll(/(?<![`\\])(`{1,2})([^`\n]+?)\1(?!`)|\*\*([^*\n]+)\*\*/g)){
      const at=start+match.index;appendStyled(target,line,offset,at);
      const code=node(match[1]?'code':'strong'),padding=match[1]?.length||2,content=match[2]??match[3];
      appendStyled(code,line,at+padding,at+padding+content.length);target.append(code);
      offset=at+match[0].length;
    }
    appendStyled(target,line,offset,end);
  }
  function cellRange(text,start,end){
    while(start<end&&/\s/.test(text[start]))start++;
    while(end>start&&/\s/.test(text[end-1]))end--;
    return{start,end,text:text.slice(start,end)};
  }
  function cells(line){
    const text=line.text,trimmed=text.trim();
    if(trimmed.length>=3&&/^[+\-=:─━═┌┐└┘├┤┬┴┼╭╮╰╯┏┓┗┛┣┫┳┻╋╔╗╚╝╠╣╦╩╬\s]+$/.test(trimmed))return{border:true};
    const unicode=/[│┃║]/.test(text),bar=unicode?/[│┃║]/:/\|/;
    const points=[];let quote=0;
    for(let i=0;i<text.length;i++){
      if(text[i]==='\\'){i++;continue;}
      if(!unicode&&text[i]==='`'){let length=1;while(text[i+length]==='`')length++;quote=quote===length?0:quote?quote:length;i+=length-1;continue;}
      if(!quote&&bar.test(text[i]))points.push(i);
    }
    if(points.length){
      const outer=bar.test(trimmed[0])&&bar.test(trimmed.at(-1));
      if(unicode&&!outer)return null;
      const boundaries=[-1,...points,text.length],ranges=[];
      for(let i=0;i<boundaries.length-1;i++)ranges.push(cellRange(text,boundaries[i]+1,boundaries[i+1]));
      if(outer){ranges.shift();ranges.pop();}
      if(ranges.length<2)return null;
      const separator=ranges.every(cell=>/^:?-{3,}:?$/.test(cell.text));
      return{cells:ranges,outer,separator,kind:unicode?'box':'pipe'};
    }
    const points2=[...text.trimEnd().matchAll(/\S.*?(?=\s{2,}\S|$)/g)];
    if(points2.length>=2)return{cells:points2.map(match=>cellRange(text,match.index,match.index+match[0].length)),kind:'aligned'};
    return null;
  }
  function tableAt(lines,start){
    const first=cells(lines[start]);if(!first)return null;
    if(first.kind==='aligned'&&(/^[+−-]?\d/.test(first.cells[0].text)||/[;{}=]/.test(lines[start].text)))return null;
    const items=[];let end=start;
    while(end<lines.length&&lines[end].text.trim()){
      const parsed=cells(lines[end]);if(!parsed)break;
      if(parsed.cells&&items.some(item=>item.kind&&item.kind!==parsed.kind))break;
      items.push({...parsed,line:lines[end]});end++;
    }
    const rows=items.filter(item=>item.cells&&!item.separator),borders=items.some(item=>item.border),separator=items.find(item=>item.separator);
    if(rows.length<2)return null;
    const kind=rows[0].kind;
    if(kind==='aligned'&&!borders){
      if(rows.length<3||!rows.slice(1).every(row=>row.cells.some(cell=>/^[+−-]?\d/.test(cell.text))))return null;
    }
    if(kind==='pipe'&&!separator&&!rows.every(row=>row.outer))return null;
    if(!rows.every(row=>row.cells.length===rows[0].cells.length))return borders?{kind:'grid',lines:lines.slice(start,end),end}:null;
    const firstRow=items.indexOf(rows[0]),nextRow=items.indexOf(rows[1]);
    const header=!!separator||items.slice(firstRow+1,nextRow).some(item=>item.border);
    return{kind:'table',rows,header,alignment:separator?.cells.map(cell=>cell.text.startsWith(':')&&cell.text.endsWith(':')?'center':cell.text.endsWith(':')?'right':'left'),end};
  }
  function appendLines(target,lines,inline=false){
    lines.forEach((line,index)=>{if(index)target.append(document.createTextNode('\n'));(inline?appendInline:appendStyled)(target,line);});
  }
  function appendCode(target,lines){if(root.TmuxCode)root.TmuxCode.paint(target,lines,appendStyled);else appendLines(target,lines);}
  function renderTable(block){
    const shell=node('div','reader-table-shell');shell.setAttribute('role','region');shell.setAttribute('aria-label',qLangReader.t('터미널 출력 표'));
    if(block.kind==='grid'){
      const pre=node('pre','reader-table-grid');appendLines(pre,block.lines);shell.append(pre);return shell;
    }
    const table=node('table','reader-table'),body=node('tbody');
    block.rows.forEach((row,index)=>{
      const tr=node('tr');
      row.cells.forEach((cell,column)=>{
        const heading=block.header&&index===0,td=node(heading?'th':'td');
        if(heading)td.setAttribute('scope','col');
        if(/^(?:[+−-]?(?:\d[\d,]*(?:\.\d*)?|\.\d+)(?:e[+−-]?\d+)?(?:\s*(?:%|ps|ns|us|µs|ms|s|Hz|kHz|MHz|GHz|mW|W|mV|V|mm|um|µm|nm))?|N\/?A|[−—-])$/i.test(cell.text))td.classList.add('numeric');
        if(block.alignment)td.style.textAlign=block.alignment[column];
        appendInline(td,row.line,cell.start,cell.end);tr.append(td);
      });
      if(block.header&&index===0){const head=node('thead');head.append(tr);table.append(head);}else body.append(tr);
    });
    table.append(body);shell.append(table);return shell;
  }
  const divider=line=>/^\s*[-─━═_–—=]{3,}\s*$/.test(line.text);
  function sliceLine(line,start){
    let offset=0;const runs=[];
    for(const run of line.runs){const from=Math.max(0,start-offset);offset+=run.text.length;if(from<run.text.length)runs.push({text:run.text.slice(from),style:run.style});}
    return{text:line.text.slice(start),runs};
  }
  function fenceAt(line){
    const match=line.text.match(/^\s*(?:(?:[-+*]|\d+[.)])\s+)?(`{3,}|~{3,})([^\n]*)$/);
    if(!match||match[1][0]==='`'&&match[2].includes('`'))return null;
    return{marker:match[1],info:match[2].trim(),language:match[2].trim().split(/\s+/)[0].replace(/^\{?\.?|\}$/g,'')};
  }
  const closesFence=(line,fence)=>{const candidate=fenceAt(line);return candidate&&!candidate.info&&candidate.marker[0]===fence.marker[0]&&candidate.marker.length>=fence.marker.length;};
  const codeLine=line=>/^(?:\s*[$└│├╭╰─]|\s*[+\-]\s|\s{4}\S)/.test(line.text)
    ||/^\s*(?:def\s+\w+\s*\(|(?:async\s+)?function\s+[\w$]+\s*\(|(?:const|let|var)\s+[\w${[][^\n]*?=|#include\s*[<"]|proc\s+\S+\s*\{|set\s+\S+\s+\[)/.test(line.text);
  function renderBlocks(lines,isMeta,{literal=false,markdownLists=false}={}){
    const fragment=document.createDocumentFragment();let group=[],kind='';
    function flush(){
      if(!group.length)return;
      const block=kind==='meta'?renderMeta(group):node(kind==='console'?'pre':'p','output-block '+kind);
      if(!kind&&!group.some(line=>/^\s*(?:[-*+•]|\d+[.)])\s+/.test(line.text)))block.classList.add('flow-prose');
      if(kind==='console'){const code=node('code');appendCode(code,group);block.append(code)}
      else if(kind!=='meta')appendLines(block,group,true);
      fragment.append(block);group=[];
    }
    for(let i=0;i<lines.length;){
      const line=lines[i],fence=literal?null:fenceAt(line);
      if(fence){
        flush();const content=[];i++;
        while(i<lines.length&&!closesFence(lines[i],fence))content.push(lines[i++]);
        if(i<lines.length)i++;
        const pre=node('pre','output-block console fenced-code'),code=node('code');code.dataset.language=fence.language;appendCode(code,content);pre.append(code);fragment.append(pre);continue;
      }
      const table=tableAt(lines,i);
      if(table){flush();fragment.append(renderTable(table));i=table.end;continue;}
      if(literal){if(kind!=='console')flush();kind='console';group.push(line);i++;continue;}
      if(divider(line)){flush();if(fragment.lastElementChild?.tagName!=='HR')fragment.append(node('hr','reader-divider'));i++;continue;}
      if(!line.text.trim()){flush();i++;continue;}
      const heading=line.text.match(/^\s*(#{1,6})\s+/);
      if(heading){flush();const title=node('h'+Math.min(heading[1].length+1,6),'reader-title');appendInline(title,line,heading[0].length);fragment.append(title);i++;continue;}
      const list=markdownLists&&/^\s*(?:[-+*]|\d+[.)])\s+\S/.test(line.text);
      const next=isMeta(line.text)?'meta':/^\s*[›❯]/.test(line.text)?'prompt':codeLine(line)&&!list?'console':'';
      if(next!==kind)flush();kind=next;group.push(line);i++;
    }
    flush();return fragment;
  }
  const toolStart=text=>/^\s*(?:[•●⏺]\s+)?(?:Ran\s|Explored\b|Viewed image\b|(?:Bash|Read|Write|Edit|Update|Search|Glob|Grep|WebFetch|Task)\(|Stop Task\b|(?:Read|Edited|Wrote|Searched|Running)\s+\d+\s+(?:files?|shell|commands?)|Background command\s)/.test(text)
    ||/^\s*[•●⏺]\s+(?:Running\s|(?:Edited|Added|Deleted)\s+\S+\s+\([+-]\d+|Updated [Pp]lan\b|Searched for\s|Listed files\b)/.test(text);
  const promptStart=/^\s*[›❯]\s*/;
  const agentStart=/^\s*[•●⏺]\s+/;
  const placeholder=/^(?:Ask Codex to do anything|Write tests for|Explain this codebase|Find and fix a bug in|Summarize recent commits|Implement \{feature\}|Run \/review|Use \/skills|Type a message)/i;
  const taskNotification=text=>/^\s*(?:<task-notification>[\s\S]*?<\/task-notification>\s*)+$/.test(text)&&/<task-id>[^<]+<\/task-id>/.test(text)&&/<(?:summary|event)>[\s\S]*?<\/(?:summary|event)>/.test(text);
  function renderMeta(lines){
    const block=node('p','output-block meta');
    for(const line of lines){
      const row=node('span','reader-meta-line');
      line.text.split(/(\s*[|·]\s*)/).forEach((part,index)=>{
        const kind=/^[\s|·]+$/.test(part)?'separator':/^(?:Opus|Sonnet|Haiku|gpt[- ]?\d|o[134]\b|codex)/i.test(part.trim())?'model':/auto mode|accept edits|plan mode|bypass permissions|⏵/i.test(part)?'mode':/\bshells?\b|background/i.test(part)?'activity':/\d|tokens?|context|weekly/i.test(part)?'usage':'';
        const span=node('span',kind?'meta-'+kind:'');span.textContent=part;row.append(span);
      });block.append(row);
    }
    return block;
  }
  function codexFooter(lines){
    let end=lines.length;while(end&&!lines[end-1].text.trim())end--;
    for(let start=end-1;start>=Math.max(0,end-4);start--){
      const first=lines[start].text.trim();
      if(!/^(?:gpt[- ]?\d[\w.-]*|o[134](?:-[\w.-]+)?|codex(?:-[\w.-]+)?)\b/i.test(first))continue;
      // A live footer is at the bottom, outside prompts/code examples. Following
      // rows may contain only the CLI's status continuation or shortcut hints.
      const tail=lines.slice(start,end).map(line=>line.text.trim());
      if(tail.slice(1).some(text=>text&&!/^(?:[|·]|context\b|weekly\b|\d[\d.,KMB]*\s+(?:used|tokens?)|[←?⚠]|(?:full access|read.only)\b)/i.test(text)))continue;
      const value=tail.join(' ');
      if(!/[·|]/.test(value)||!/(?:\bcontext\s+\d+(?:\.\d+)?(?:%|…|\.{3})|\bweekly\s+\d+(?:\.\d+)?%|\b[\d.]+[KMB]?\s+(?:used|tokens?)|\bfull\s+a(?:ccess\b|…|\.{3})|\bread.only\b|\d+ warnings?\b.*\bf2\b)/i.test(value))continue;
      return {start,end,text:value};
    }
    return null;
  }
  function codexStatus(source){
    const footer=codexFooter(source.split('\n').map(text=>({text:text.replace(escapePattern,'')})));
    if(!footer)return null;
    const text=footer.text,model=text.match(/^((?:gpt[- ]?\d[\w.-]*|o[134](?:-[\w.-]+)?|codex(?:-[\w.-]+)?))(?:\s+(low|medium|high|xhigh|max|ultra))?\b/i);
    const percentage=name=>{const match=text.match(new RegExp('\\b'+name+'\\s+(\\d+(?:\\.\\d+)?)%\\s+(left|remaining|used)\\b','i'));return match?{value:Math.min(100,Math.max(0,Number(match[1]))),remaining:match[2].toLowerCase()!=='used'}:null;};
    return {model:model?.[1]||'Codex',reasoning:model?.[2]||'',context:percentage('context'),weekly:percentage('weekly'),
      tokens:text.match(/\b([\d,.]+(?:[KMB])?)\s+(?:used|tokens?(?:\s+used)?)\b/i)?.[1]||'',
      access:text.match(/\b(?:full access|read.only|workspace.write|auto(?:matic)?(?: mode)?)\b/i)?.[0]||'',
      hint:text.match(/←\s+for agents\b/i)?.[0]||''};
  }
  function withoutCodexFooter(source){
    const lines=source.split('\n'),footer=codexFooter(lines.map(text=>({text:text.replace(escapePattern,'')})));
    return footer?lines.slice(0,footer.start).join('\n'):source;
  }
  function renderCodexStatus(status){
    const panel=node('p','output-block meta codex-status');panel.setAttribute('aria-label','Codex usage');
    const row=node('span','reader-meta-line'),model=node('span','meta-model');
    model.textContent=status.model.replace(/^gpt/i,'GPT')+(status.reasoning?' '+status.reasoning:'');row.append(model);
    const append=(value,className,key)=>{const separator=node('span','meta-separator'),part=node('span',className);separator.textContent=' · ';part.textContent=value;if(key)part.dataset.metric=key;row.append(separator,part);};
    if(status.access)append(status.access,'meta-mode');
    for(const [key,label] of [['context','Context'],['weekly','weekly'],['tokens','']]){
      const value=status[key];if(value==null||value==='')continue;
      append(key==='tokens'?value+' used':label+' '+value.value+'% '+(value.remaining?'left':'used'),'meta-usage',key);
    }
    if(status.primary){const hours=status.primary.minutes/60;append((Number.isFinite(hours)?hours+'h ':'Limit ')+status.primary.value+'% left','meta-usage','primary');}
    if(Number.isFinite(status.total_tokens))panel.title='Total '+status.total_tokens.toLocaleString()+' tokens'+(Number.isFinite(status.cached_input_tokens)?' · cached '+status.cached_input_tokens.toLocaleString():'');
    if(status.hint)append(status.hint,'meta-hint');
    panel.append(row);
    return panel;
  }
  function withoutLiveInput(lines){
    // Codex's bottom prompt is an editor, including pasted but unsent text.
    // Its current footer bounds this editor even on narrow, ellipsized screens.
    const footer=codexFooter(lines);
    if(footer){
      for(let index=footer.start-1;index>=0;index--){
        if(!promptStart.test(lines[index].text))continue;
        const draft=lines.slice(index+1,footer.start);
        if(draft.every(line=>!line.text.trim()||/^\s{2,}\S/.test(line.text)&&!agentStart.test(line.text)&&!divider(line)))return [...lines.slice(0,index),...lines.slice(footer.start)];
        break;
      }
    }
    // Claude encloses its editable prompt (including ghost suggestions) in rules.
    // Only remove the last such region when the live model footer follows it.
    for(let index=lines.length-1;index>=0;index--){
      if(!promptStart.test(lines[index].text))continue;
      let above=index-1;while(above>=0&&!lines[above].text.trim())above--;
      if(above<0||!divider(lines[above]))return lines;
      let below=index+1;while(below<lines.length&&!divider(lines[below]))below++;
      if(below<lines.length&&lines.slice(below+1,below+9).some(line=>/^\s*(?:(?:Opus|Sonnet|Haiku)\b|⏵)/.test(line.text)))return [...lines.slice(0,above),...lines.slice(below+1)];
      return lines;
    }
    return lines;
  }
  function renderUser(group,isMeta,terminal=false,attachments=[]){
    // A CLI often paints the submitted prompt as a selection. Its SGR background,
    // inverse colors and continuation gutter are terminal chrome, not user markup.
    group=group.map((line,index)=>{const plain=terminal&&index&&line.text.startsWith('  ')?sliceLine(line,2):line;return{text:plain.text,runs:plain.runs.map(run=>({text:run.text,style:{}}))}});
    const message=node('section','chat-message user');message.setAttribute('aria-label',qLangReader.t('내 메시지'));
    const attachmentAt=group.findIndex(item=>item.text.trim()==='첨부 파일 (이 서버에 저장된 임시 원본):');
    message.append(renderBlocks(attachmentAt<0?group:group.slice(0,attachmentAt),()=>false));
    if(attachmentAt>=0&&!attachments.length){for(const item of group.slice(attachmentAt+1)){const match=item.text.trim().match(/^- (".*")$/);if(!match)continue;try{const path=JSON.parse(match[1]),id=path.match(/\/attachments\/([a-f0-9]{32})\/[^/]+$/)?.[1];attachments.push({name:path.split('/').at(-1),url:id?'/api/attachments/'+id+'/preview':''});}catch{}}}
    if(attachments.length){
      const files=node('div','chat-attachments');
      for(const item of attachments){
        const allowed=typeof item.url==='string'&&/^\/api\/attachments\/[a-f0-9]{32}\/preview$/.test(item.url);
        const file=node(allowed?'a':'span','chat-file'+(allowed?' chat-file-preview':''));file.title=item.name||qLangReader.t('첨부 파일');
        if(allowed){
          file.href=item.url;file.target='_blank';file.rel='noopener';
          file.dataset.imageViewer=item.url;file.dataset.imageName=item.name||qLangReader.t('첨부 이미지');
          const image=node('img','chat-attachment-image');image.alt=item.name||qLangReader.t('첨부 이미지');image.loading='lazy';image.decoding='async';image.dataset.previewState='loading';
          image.addEventListener('load',()=>{image.dataset.previewState='ready';image.hidden=false;});
          image.addEventListener('error',async()=>{
            if(!image.isConnected)return;
            if(image.dataset.previewState==='retry'){image.dataset.previewState='unavailable';image.hidden=true;return;}
            image.dataset.previewState='retry';
            try{
              const response=await fetch(item.url,{credentials:'same-origin',cache:'no-store'});if(!response.ok)throw new Error('Preview unavailable');
              const blob=await response.blob(),reader=new FileReader();
              reader.onload=()=>{if(image.isConnected)image.src=reader.result;};reader.readAsDataURL(blob);
            }catch{image.dataset.previewState='unavailable';image.hidden=true;}
          });
          files.append(file);file.append(image);image.src=item.url;
        }
        const caption=node('span','chat-file-name');caption.textContent='📎 '+(item.name||qLangReader.t('첨부 파일'));file.append(caption);if(!allowed)files.append(file);
      }
      message.append(files);
    }
    return message;
  }
  const imageCache=new Map();
  async function mediaBlob(url){
    if(imageCache.has(url)){const entry=imageCache.get(url);imageCache.delete(url);imageCache.set(url,entry);return entry.promise;}
    const entry={bytes:0};
    entry.promise=fetch(url,{credentials:'same-origin'}).then(async response=>{
      if(!response.ok)throw new Error(response.status===401?qLangReader.t('다시 로그인해 주세요.'):qLangReader.t('원본 이미지가 없거나 대화 세션이 바뀌었어요.'));
      const blob=await response.blob();if(!blob.type.startsWith('image/'))throw new Error(qLangReader.t('이미지를 읽을 수 없어요.'));entry.bytes=blob.size;
      let total=[...imageCache.values()].reduce((sum,value)=>sum+value.bytes,0);
      for(const [key,value] of imageCache){if(imageCache.size<=24&&total<=64*1024*1024)break;if(key!==url){imageCache.delete(key);total-=value.bytes;}}
      return blob;
    }).catch(error=>{imageCache.delete(url);throw error;});
    imageCache.set(url,entry);return entry.promise;
  }
  function renderMedia(media,key){
    const fragment=document.createDocumentFragment();
    const seen=new Set();media=media.filter(item=>typeof item.url==='string'&&/^\/api\/panes\/[^/?]+\/media\?ref=[a-zA-Z0-9%:._-]+$/.test(item.url)&&!seen.has(item.url)&&seen.add(item.url));
    if(!media.length)return fragment;
    const details=node('details','reader-media'),summary=node('summary');
    details.dataset.readerKey='media-group:'+key;details.dataset.sourceMessageId=key;
    summary.textContent=qLangReader.t('사진 ')+media.length+qLangReader.t('장');details.append(summary);
    const gallery=node('div','reader-media-gallery');details.append(gallery);fragment.append(details);
    for(const [index,item] of media.entries()){
      const figure=node('figure','reader-media-item'),image=node('img','reader-media-image'),caption=node('figcaption'),status=node('span','reader-media-status'),original=node('a','reader-media-original'),retry=node('button','reader-media-retry');
      figure.dataset.sourceMessageId=item.messageId||key;
      image.alt=item.name||qLangReader.t('도구 이미지');image.decoding='async';image.hidden=true;
      original.textContent=(item.name||qLangReader.t('이미지'))+qLangReader.t(' · 원본 보기');original.href=item.url;original.target='_blank';original.rel='noopener noreferrer';
      original.dataset.imageViewer=item.url;original.dataset.imageName=item.name||qLangReader.t('이미지 원본');
      image.dataset.imageViewer=item.url;image.dataset.imageName=item.name||qLangReader.t('이미지 원본');image.style.cursor='zoom-in';
      retry.type='button';retry.textContent=qLangReader.t('다시 불러오기');retry.hidden=true;status.setAttribute('role','status');
      caption.append(original,status,retry);figure.append(image,caption);gallery.append(figure);
      let loading=false,loaded=false;
      async function load(){
        if(loaded||loading||!details.open||!details.isConnected)return;
        for(let parent=details.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS'&&!parent.open)return;
        loading=true;retry.hidden=true;status.textContent=qLangReader.t('불러오는 중…');
        try{
          const blob=await mediaBlob(item.url);if(!image.isConnected)return;
          const url=URL.createObjectURL(blob);image.onload=()=>URL.revokeObjectURL(url);image.onerror=()=>{URL.revokeObjectURL(url);imageCache.delete(item.url);image.hidden=true;loaded=false;retry.hidden=false;status.textContent=qLangReader.t('이미지를 표시할 수 없어요.');};
          image.src=url;image.hidden=false;loaded=true;status.textContent='';
        }catch(error){if(status.isConnected){status.textContent=error.message;retry.hidden=false;}}
        finally{loading=false;}
      }
      details.addEventListener('toggle',load);retry.onclick=load;
    }
    return fragment;
  }
  const questionAnswers=(group,question)=>group.answers?.[question.id]||group.answers?.[question.prompt]||[];
  function questionMessages(messages){
    const groups=new Map();
    for(const message of messages)if(message.question?.questions?.length)groups.set(message.question.call_id||message.id,null);
    for(const message of messages){
      const value=message.question||message.question_reply,key=value?.call_id||message.id;
      if(groups.has(key)){
        const previous=groups.get(key);
        groups.set(key,{...previous,...value,questions:value.questions?.length?value.questions:previous?.questions||[],
          answers:{...previous?.answers,...value.answers},annotations:{...previous?.annotations,...value.annotations}});
      }
      if(message.role==='user'){
        const matches=[];
        for(const group of groups.values())if(group?.async)for(const q of group.questions||[])if(!group.answers?.[q.id])for(const option of q.options){
          const text=(message.plain??message.text??'').trim();if(text===option.label||text===q.prompt+'\n답변: '+option.label)matches.push({group,q,label:option.label});
        }
        if(matches.length===1){const {group,q,label}=matches[0];group.answers={...group.answers,[q.id]:[label]};group.state=group.questions.every(q=>group.answers[q.id]?.length)?'answered':'asked';}
      }
    }
    const result=[],seen=new Set();
    for(const message of messages){
      const value=message.question||message.question_reply,key=value?.call_id||message.id,group=groups.get(key);
      if(!group){result.push(message);continue;}
      if(seen.has(key))continue;seen.add(key);
      const text=group.questions.map(q=>[q.prompt,...q.options.map((o,i)=>(i+1)+'. '+o.label+(o.description?'\n'+o.description:'')+(o.preview?'\n'+o.preview:'')),
        ...(questionAnswers(group,q).length?['답변: '+questionAnswers(group,q).join(', ')]:[])].join('\n\n')).join('\n\n');
      result.push({...message,id:'question:'+key,role:'question',question:group,text,plain:text});
    }
    return result;
  }
  function questionPreview(text,key){
    const details=node('details','reader-question-preview'),summary=node('summary');summary.textContent=qLangReader.t('미리보기');details.dataset.readerKey='question-preview:'+key;
    const shell=node('div','reader-table-shell reader-question-diagram'),pre=node('pre','reader-table-grid');pre.textContent=text;shell.append(pre);details.append(summary,shell);return details;
  }
  function renderQuestion(group,isMeta){
    const article=node('article','reader-question-set');article.dataset.questionCall=group.call_id;
    const heading=node('header','reader-question-heading'),label=node('span'),status=node('span','reader-question-state');
    label.textContent=group.questions.length>1?qLangReader.t('질문 ')+group.questions.length+qLangReader.t('개'):qLangReader.t('질문');status.textContent=group.state==='answered'?qLangReader.t('답변 완료'):group.async?qLangReader.t('답변 대기'):Object.keys(group.answers||{}).length?qLangReader.t('답변 완료'):qLangReader.t('질문 기록');heading.append(label,status);article.append(heading);
    for(const question of group.questions){
      const section=node('section','reader-question');
      if(question.header){const title=node('p','reader-question-header');title.textContent=question.header;section.append(title);}
      const prompt=node('div','reader-question-prompt');prompt.append(renderBlocks(parseAnsi(question.prompt),isMeta,{markdownLists:true}));section.append(prompt);
      const answers=questionAnswers(group,question),options=node('ol','reader-question-options'),selectedLabels=[];
      for(const [index,option] of question.options.entries()){
        const selected=answers.includes(option.label)||(question.multiple&&answers.some(answer=>answer.split(', ').includes(option.label)));
        if(selected)selectedLabels.push(option.label);
        const item=node('li','reader-question-option');item.dataset.selected=String(selected);
        const actionable=group.async&&!answers.length, name=node(actionable?'button':'div','reader-question-option-name'+(actionable?' reader-question-select':'')),title=node('strong');appendInline(title,parseAnsi(option.label)[0]||{text:'',runs:[]});name.append(title);
        if(actionable){name.type='button';name.addEventListener('click',()=>name.dispatchEvent(new CustomEvent('reader-question-answer',{bubbles:true,detail:{call_id:group.call_id,question_id:question.id,choice:index}})));}
        if(selected){const mark=node('span','reader-question-chosen');mark.textContent=qLangReader.t('선택한 답변');name.append(mark);}item.append(name);
        if(option.description){const description=node('div','reader-question-description');description.append(renderBlocks(parseAnsi(option.description),isMeta,{markdownLists:true}));item.append(description);}
        if(option.preview)item.append(questionPreview(option.preview,group.call_id+':'+question.id+':'+index));options.append(item);
      }
      if(question.options.length)section.append(options);
      const annotation=group.annotations?.[question.id]||group.annotations?.[question.prompt],extraPreview=annotation?.preview&&!question.options.some(option=>option.preview===annotation.preview);
      const choiceOnly=answers.every(answer=>selectedLabels.includes(answer)||question.multiple&&answer.split(', ').every(label=>selectedLabels.includes(label)));
      if(answers.length&&(!choiceOnly||extraPreview)){const answer=node('div','reader-question-answer'),label=node('span');label.textContent=qLangReader.t('내 답변');answer.append(label,renderBlocks(parseAnsi(answers.join('\n')),isMeta,{markdownLists:true}));
        if(extraPreview)answer.append(questionPreview(annotation.preview,group.call_id+':'+question.id+':answer'));
        section.append(answer);}
      article.append(section);
    }
    return article;
  }
  function renderMessages(messages,isMeta=()=>false){
    const fragment=document.createDocumentFragment();let assistant=null,activities=[],textParts=[],speaker='',mediaItems=[],mediaKey='';
    const host=()=>{if(!assistant){assistant=node('section','chat-message assistant');fragment.append(assistant);}return assistant;};
    function flushMedia(){if(mediaItems.length)host().append(renderMedia(mediaItems,mediaKey));mediaItems=[];mediaKey='';}
    function flushText(){if(!textParts.length)return;const body=node('div','message-part');body.dataset.messageId=textParts[0].id;body.append(renderBlocks(parseAnsi(textParts.map(item=>item.text).join('\n\n')),isMeta,{markdownLists:true}));host().append(body);textParts=[];}
    function flush(){if(!activities.length)return;const details=node('details','reader-activity'),summary=node('summary'),body=node('div','activity-body');
      summary.textContent=qLangReader.t('실행 기록 ')+activities.length+qLangReader.t('개');details.dataset.readerKey=activities[0].id;
      for(const item of activities){const tool=node('div','reader-tool');tool.dataset.messageId=item.id;if(item.title){const title=node('div','reader-tool-title');title.textContent=item.title;tool.append(title)}tool.append(renderBlocks(parseAnsi(item.text),isMeta,{literal:true}));body.append(tool)}
      details.append(summary,body);host().append(details);
      for(const item of activities)if(item.media?.length){if(!mediaKey)mediaKey=item.id;mediaItems.push(...item.media.map(image=>({...image,messageId:item.id})));}
      activities=[];}
    for(const message of questionMessages(messages)){
      if(['round','status'].includes(message.role)){
        flushText();flush();flushMedia();assistant=null;speaker='';
        const event=node(message.role==='round'?'div':'p',message.role==='round'?'chat-round':'chat-event');event.dataset.messageId=message.id;
        event.textContent=(message.role==='status'&&message.speaker?message.speaker+' · ':'')+message.text;fragment.append(event);continue;
      }
      if(message.speaker&&message.role==='assistant'&&message.speaker!==speaker){
        flushText();flush();flushMedia();assistant=null;speaker=message.speaker;
        const section=host();section.dataset.speaker=speaker;section.setAttribute('aria-label',speaker+qLangReader.t(' 메시지'));
        const heading=node('header','chat-speaker'),name=node('strong');name.textContent=speaker;heading.append(name);
        if(message.timestamp){const time=node('time');time.dateTime=new Date(message.timestamp*1000).toISOString();time.textContent=new Date(message.timestamp*1000).toLocaleTimeString(qLangReader.locale,{hour:'2-digit',minute:'2-digit'});heading.append(time);}
        section.append(heading);
      }
      if(message.role==='activity'){flushText();activities.push(message);continue;}
      if(message.role==='question'&&message.question?.questions?.length){flushText();flush();const question=renderQuestion(message.question,isMeta);question.dataset.messageId=message.id;host().append(question);continue;}
      flush();
      if(message.role==='user'){flushText();flushMedia();assistant=null;speaker='';const user=renderUser(parseAnsi(message.text),isMeta,false,[...(message.attachments||[])]);user.dataset.messageId=message.id;fragment.append(user);}
      else if(message.role==='assistant')textParts.push(message);
    }
    flushText();flush();flushMedia();return fragment;
  }
  function render(source,isMeta=()=>false){
    let lines=withoutLiveInput(parseAnsi(source));const footer=codexFooter(lines);if(footer)lines=lines.slice(0,footer.start);
    const fragment=document.createDocumentFragment();let assistant=null,body=[],activities=[],fence=null;
    const host=()=>{if(!assistant){assistant=node('section','chat-message assistant');fragment.append(assistant);}return assistant;};
    const flushBody=()=>{if(body.length){host().append(renderBlocks(body,isMeta));body=[];}};
    function flushActivity(){
      if(!activities.length)return;
      const details=node('details','reader-activity'),summary=node('summary');summary.textContent=qLangReader.t('실행 기록 ')+activities.length+qLangReader.t('개');
      details.dataset.readerKey=activities[0][0]?.text.slice(0,160)||'';
      const content=node('div','activity-body');for(const group of activities)content.append(renderBlocks(group,isMeta,{literal:true}));
      details.append(summary,content);host().append(details);activities=[];
    }
    for(let i=0;i<lines.length;){
      const line=lines[i],prompt=line.text.match(promptStart);
      // Welcome screens are terminal layouts, not assistant prose or tables.
      // Preserve their command-per-line layout, box borders and ANSI styles.
      const welcome=/OpenAI Codex\s*\(v[\d.]|Claude Code\s+v\d/.test(line.text)
        ||/[╭┌]/.test(line.text)&&lines.slice(i+1,i+4).some(row=>/OpenAI Codex\s*\(v|Claude Code\s+v\d/.test(row.text));
      if(!fence&&welcome){
        flushBody();flushActivity();const start=i++;
        while(i<lines.length&&!promptStart.test(lines[i].text)&&!agentStart.test(lines[i].text))i++;
        const shell=node('div','reader-table-shell reader-welcome');shell.setAttribute('aria-label',qLangReader.t('CLI 시작 화면'));
        const pre=node('pre','reader-table-grid');appendLines(pre,lines.slice(start,i));shell.append(pre);host().append(shell);continue;
      }
      const agent=line.text.match(agentStart),candidate=agent?sliceLine(line,agent[0].length):line,codeFence=fenceAt(candidate);
      if(fence){body.push(line);if(closesFence(line,fence))fence=null;i++;continue;}
      if(codeFence){if(agent)flushBody();flushActivity();fence=codeFence;body.push(candidate);i++;continue;}
      if(prompt){
        flushBody();flushActivity();assistant=null;
        const group=[sliceLine(line,prompt[0].length)];i++;
        const indent=line.text.length-line.text.trimStart().length;
        while(i<lines.length&&(!lines[i].text.trim()||/^\s{2,}\S/.test(lines[i].text))&&!((agentStart.test(lines[i].text)||divider(lines[i]))&&lines[i].text.length-lines[i].text.trimStart().length<=indent))group.push(lines[i++]);
        if(!group[0].text.trim()||placeholder.test(group[0].text.trim())){const metadata=group.slice(1).filter(item=>isMeta(item.text));if(metadata.length)host().append(renderBlocks(metadata,isMeta));continue;}
        // Terminal captures have no record metadata. Only a complete native
        // envelope at the prompt is an automatic event; quoted examples remain.
        if(taskNotification(group.map(item=>item.text).join('\n'))){activities.push(group);continue;}
        fragment.append(renderUser(group,isMeta,true));continue;
      }
      if(toolStart(line.text)){
        flushBody();const group=[line];i++;
        const indent=line.text.length-line.text.trimStart().length;
        while(i<lines.length&&(!lines[i].text.trim()||/^\s{2,}\S/.test(lines[i].text))&&!((agentStart.test(lines[i].text)||promptStart.test(lines[i].text)||divider(lines[i]))&&lines[i].text.length-lines[i].text.trimStart().length<=indent))group.push(lines[i++]);
        activities.push(group);continue;
      }
      if(agentStart.test(line.text)){flushBody();flushActivity();body.push(sliceLine(line,line.text.match(agentStart)[0].length));}
      else if(line.text.trim()||!activities.length){if(line.text.trim())flushActivity();body.push(line);}
      i++;
    }
    flushBody();flushActivity();return fragment;
  }
  function renderGrid(source){const pre=node('pre','terminal-history-grid');appendLines(pre,parseAnsi(source));return pre;}
  function fitTables(container){
    for(const shell of container.querySelectorAll('.reader-table-shell')){
      const content=shell.firstElementChild,available=shell.clientWidth;if(!content||!available)continue;
      content.style.transform='';const width=Math.max(content.offsetWidth,content.scrollWidth),height=content.offsetHeight;
      if(!width||!height)continue;
      const scale=Math.min(1,available/width);content.style.transform=`scale(${scale})`;shell.style.height=Math.ceil(height*scale)+'px';shell.dataset.scale=String(scale);
    }
  }
  root.TmuxReader={parseAnsi,tableAt,render,renderMessages,renderMeta,codexStatus,renderCodexStatus,withoutCodexFooter,withoutLiveInput,renderGrid,fitTables,taskNotification,readableLightInk,questionMessages,questionPreview};
})(globalThis);
