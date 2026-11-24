/* A single, on-demand explorer belongs to the server, never to each tmux frame. */
(()=>{
 'use strict';
 const t=value=>window.QI18n?.t(value)??value;
 const node=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=text;n.className=cls;return n};
 const button=(text,action,label=text)=>{const n=node('button',t(text));n.type='button';n.setAttribute('aria-label',t(label));n.onclick=action;return n};
 const iconButton=(label,path,action)=>{const n=button('',action,label);n.className='file-preview-icon';n.title=t(label);const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.6');svg.setAttribute('aria-hidden','true');svg.innerHTML=path;n.append(svg);return n;};
 const size=value=>value==null?'':value<1024?value+' B':value<1024**2?(value/1024).toFixed(1)+' KB':(value/1024**2).toFixed(1)+' MB';
 class FileBrowser{
  constructor({hosts,context,api,notice,readOnly=false}){Object.assign(this,{hosts,context,api,notice,readOnly});this.states=new Map();this.generation=0;this.host='';this.opened=false;this.blob='';this.busy=false;}
  mount(){
   if(this.shell)return;
   this.shell=node('aside','','file-browser');this.shell.id='q-file-browser';this.shell.hidden=true;this.shell.setAttribute('role','dialog');this.shell.setAttribute('aria-label',t('서버 파일 보기'));
   const heading=node('header'),title=node('strong',t('파일'));title.prepend(TmuxFileIcon('folder'));this.servers=node('select');this.servers.setAttribute('aria-label',t('파일 서버'));this.servers.onchange=()=>this.open({host:this.servers.value});
   heading.append(title,this.servers,button('휴지통',()=>this.openTrash(this.host)),button('×',()=>this.close(),'파일 보기 닫기'));
   const tools=node('div','','file-browser-tools');tools.append(button('↑',()=>this.navigate(this.directory?.parent||''),'상위 폴더'),button('홈',()=>this.navigate('')),button('작업 폴더',()=>this.open({...this.context(),current:true}),'현재 작업 폴더'),button('↻',()=>this.trash?this.loadTrash():this.navigate(this.directory?.path||'',true),'파일 새로고침'));
   this.hidden=node('input');this.hidden.type='checkbox';this.hidden.onchange=()=>this.navigate(this.directory?.path||'',true);const hidden=node('label',t('숨김 파일'));hidden.prepend(this.hidden);tools.append(hidden);
   this.location=node('div','','file-browser-location');this.breadcrumb=node('nav','','file-browser-breadcrumb');this.breadcrumb.setAttribute('aria-label',t('현재 폴더 경로'));this.location.append(this.breadcrumb,button('경로',()=>{this.location.hidden=true;this.pathForm.hidden=false;this.path.focus();this.path.select()},'경로 입력'));
   this.pathForm=node('form','','file-browser-path');this.pathForm.hidden=true;this.path=node('input');this.path.setAttribute('aria-label',t('파일 또는 폴더 경로'));this.path.autocomplete='off';this.path.spellcheck=false;const go=node('button',t('이동'));go.type='submit';this.pathForm.append(this.path,go);this.pathForm.onsubmit=e=>{e.preventDefault();this.navigate(this.path.value)};
   this.status=node('p','','file-browser-status');this.status.setAttribute('role','status');this.body=node('div','','file-browser-body');
   this.list=node('nav','','file-browser-list');this.list.setAttribute('aria-label',t('파일과 폴더'));this.view=node('section','','file-browser-preview');this.previewArea=node('div','','file-browser-preview-area');this.previewArea.append(this.view);this.body.append(this.list,this.previewArea);this.view.addEventListener('pointerdown',()=>this.activateSplit(null));
   this.tree=new TmuxFileTree(this.list,{load:(path,offset,signal)=>this.api(this.url(path,'list',offset),{signal}),open:entry=>this.navigate(entry.path),preview:entry=>this.openFile(entry.path),menu:(...args)=>this.contextMenu(...args),update:data=>{this.directory=data;this.entries=data.entries}});
   this.uploadInput=node('input');this.uploadInput.type='file';this.uploadInput.multiple=true;this.uploadInput.hidden=true;this.uploadInput.setAttribute('aria-label',t('첨부할 파일 선택'));this.uploadInput.onchange=()=>{const files=[...this.uploadInput.files],target=this.uploadTarget;this.uploadInput.value='';if(files.length&&target)this.uploadFiles(files,target)};
   this.dropHint=node('div','','file-drop-hint');this.dropHint.hidden=true;this.dropHint.setAttribute('data-user-content','');
   this.shell.append(heading,tools,this.location,this.pathForm,this.status,this.body,this.uploadInput,this.dropHint);document.body.append(this.shell);TmuxFileLayout.mount(this);this.emptyPreview();
   this.events=new AbortController();const options={signal:this.events.signal};
   window.addEventListener('beforeunload',event=>{if(!this.allowUnload&&this.unsaved()){event.preventDefault();event.returnValue='';}},options);
   document.addEventListener('q-outside-press',e=>{if(!this.menu?.contains(e.detail.target))this.menu?.remove()},options);
   this.shell.addEventListener('dragover',event=>{if(![...event.dataTransfer.types].includes('Files'))return;event.preventDefault();event.stopPropagation();if(this.readOnly||this.busy||this.trash){event.dataTransfer.dropEffect='none';return;}event.dataTransfer.dropEffect='copy';const target=this.dropTarget(event.target);this.clearDrop();target.element.classList.add('file-drop-target');this.dropElement=target.element;this.dropHint.textContent=target.name+' · '+t('파일을 놓아 첨부');this.dropHint.hidden=false;},options);
   this.shell.addEventListener('dragleave',event=>{if(!this.shell.contains(event.relatedTarget))this.clearDrop()},options);
   this.shell.addEventListener('drop',event=>{if(![...event.dataTransfer.types].includes('Files'))return;event.preventDefault();event.stopPropagation();const target=this.dropTarget(event.target);this.clearDrop();if(this.readOnly||this.busy||this.trash)return;if([...event.dataTransfer.items].some(item=>item.webkitGetAsEntry?.()?.isDirectory)){this.status.textContent=t('폴더 안의 파일을 선택해 주세요.');return;}if(event.dataTransfer.files.length)this.uploadFiles([...event.dataTransfer.files],target)},options);
   document.addEventListener('dragend',()=>this.clearDrop(),options);
   document.addEventListener('keydown',e=>{if(e.key==='Escape'&&this.opened){if(e.target===this.path){this.pathForm.hidden=true;this.location.hidden=false;this.location.querySelector('button:last-child').focus()}else if(this.menu?.isConnected)this.menu.remove();else this.close();e.stopPropagation()}},options);
  }
  unsaved(){return !!this.editor&&this.editor.value!==this.original||[...this.previewArea?.querySelectorAll('.file-split-frame')||[]].some(frame=>{try{return frame.contentWindow.TmuxFiles?.unsaved()}catch{return false}});}
  destroy(){this.close(true);this.events?.abort();this.resizeObserver?.disconnect();this.shell?.remove();}
  leave(all=false){return !(all?this.unsaved():this.editor&&this.editor.value!==this.original)||confirm(t('저장하지 않은 파일 수정 내용을 버릴까요?'));}
  async open(options={}){
   this.mount();if(this.busy||!this.leave()){this.servers.value=this.host;return;}
   const available=this.hosts(),fallback=this.context(),host=options.host||this.host||fallback.host||available[0]?.id;
   if(!available.some(h=>h.id===host)){this.notice('서버를 선택해 주세요.');return;}
   this.returnFocus=document.activeElement;this.opened=true;this.shell.hidden=false;if(this.host!==host){this.directory=null;this.entries=[];this.list.replaceChildren();this.view.replaceChildren();this.release()}this.host=host;this.trash=false;this.editor=null;this.body.classList.remove('show-preview','is-trash');
   this.servers.replaceChildren(...available.map(h=>new Option(h.name,h.id)));this.servers.value=host;ServerNavigation.paint(this.shell,host);
   await this.navigate(options.path??this.states.get(host)?.path??'',false,true);this.path.focus({preventScroll:true});
  }
  close(force=false){if(!force&&document.body.classList.contains('file-view-window')){if(window.frameElement){parent.TmuxFiles?.closeSplit(window.frameElement);return;}if(!this.leave(true))return;this.allowUnload=true;if(window.opener)window.close();else location.assign('/');return;}if(!force&&!this.leave())return;this.generation++;this.controller?.abort();this.tree?.reset();if(this.shell)this.shell.hidden=true;this.opened=false;this.editor=null;this.menu?.remove();this.release();if(force){this.states.clear();this.view?.replaceChildren();this.list?.replaceChildren();this.previewArea?.replaceChildren(this.view);this.activeFrame=null;this.file=null}else this.returnFocus?.focus?.({preventScroll:true});}
  emptyPreview(){const empty=node('div','','file-preview-empty');empty.append(TmuxFileIcon('document'),node('strong',t('파일 미리보기')),node('p',t('목록에서 파일을 선택하세요.')));this.view.replaceChildren(empty)}
  renderLocation(data){this.location.hidden=false;this.pathForm.hidden=true;this.breadcrumb.replaceChildren();this.breadcrumb.title=data.path;const segments=data.path.split('/').filter(Boolean),parts=[{name:'/',path:'/'}];if(segments.length>4)parts.push({name:'…',path:'/'+segments.slice(0,-4).join('/')});for(let i=Math.max(0,segments.length-4);i<segments.length;i++)parts.push({name:segments[i],path:'/'+segments.slice(0,i+1).join('/')});for(const [index,part]of parts.entries()){if(index)this.breadcrumb.append(node('span','›'));const crumb=button('',()=>this.navigate(part.path),part.path);crumb.textContent=part.name;crumb.setAttribute('data-user-content','');if(index===parts.length-1)crumb.setAttribute('aria-current','location');this.breadcrumb.append(crumb)}requestAnimationFrame(()=>{this.breadcrumb.scrollLeft=this.breadcrumb.scrollWidth})}
  release(){for(const url of [this.blob,...(this.blobs||[])])if(url)URL.revokeObjectURL(url);this.blob='';this.blobs=[];}
  url(path,mode='list',offset=0,refresh=false){return '/api/files?'+new URLSearchParams({host:this.host,path,mode,hidden:this.hidden?.checked?'1':'0',offset,refresh:refresh?'1':'0'})}
  async request(url){this.controller?.abort();this.controller=new AbortController();return this.api(url,{signal:this.controller.signal})}
  async navigate(path,refresh=false,skipLeave=false){
   if(!skipLeave&&(this.busy||!this.leave()))return;this.editor=null;this.file=null;this.tree.reset();this.emptyPreview();this.release();this.trash=false;this.body.classList.remove('is-trash');this.menu?.remove();this.hidden.disabled=false;const generation=++this.generation;this.status.textContent=t('불러오는 중…');
   try{const data=await this.request(this.url(path,'list',0,refresh));if(generation!==this.generation)return;
    if(data.kind==='file'){const parent=await this.api(this.url(data.parent));if(generation!==this.generation)return;this.directory=parent;this.entries=parent.entries;this.states.set(this.host,{path:parent.path});this.renderList();this.preview(data);return;}
    this.directory=data;this.states.set(this.host,{path:data.path});this.path.value=data.path;this.entries=data.entries;this.body.classList.remove('show-preview');this.renderList();this.status.textContent=data.capped?t('항목이 많은 폴더예요. 경로로 파일을 직접 열 수도 있어요.'):'';
   }catch(error){if(error.name!=='AbortError'&&generation===this.generation)this.status.textContent=error.message;}
  }
  renderList(){
   this.tree.setRoot(this.directory);this.renderLocation(this.directory);
  }
  async openFile(path){if(this.activeFrame?.isConnected){const target=this.activeFrame.contentWindow?.TmuxFiles;if(target){await target.open({host:this.host,path});this.body.classList.add('show-preview');this.tree.select(path);return;}}if(this.busy||!this.leave())return;this.editor=null;const generation=++this.generation;this.status.textContent=t('파일을 여는 중…');try{const data=await this.request(this.url(path,'preview'));if(generation===this.generation)this.preview(data)}catch(e){if(e.name!=='AbortError'&&generation===this.generation)this.status.textContent=e.message}}
  preview(data){
   if(document.body.classList.contains('file-view-window')){this.shell.classList.add('file-preview-only');document.title=data.name+' · '+this.host+' · Q files';}
   this.release();this.file=data;this.tree.select(data.path);this.editor=null;this.original=data.text;this.path.value=data.path;this.view.replaceChildren();this.body.classList.add('show-preview');
   const heading=node('header'),back=button('‹ 목록',()=>this.body.classList.remove('show-preview')),name=node('strong',data.name);back.onpointerdown=event=>event.stopPropagation();name.title=data.path;
   const actions=node('div','','file-preview-actions');actions.append(iconButton('좌우 분할','<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',()=>this.split('x')),iconButton('상하 분할','<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/>',()=>this.split('y')),iconButton('파일 새 창에서 열기','<path d="M14 3h7v7m0-7L11 13M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',()=>TmuxFileLayout.detach(this)));const more=button('⋯',()=>this.previewMenu(more),'파일 메뉴');more.className='file-preview-icon';more.title=t('파일 메뉴');more.setAttribute('aria-haspopup','menu');actions.append(more);if(this.shell.classList.contains('file-preview-only'))actions.append(button('×',()=>this.close(),'이 파일 창 닫기'));heading.append(back,name,actions);this.view.append(heading);
   this.content=node('div','','file-preview-content');this.view.append(this.content);this.status.textContent=size(data.bytes)+(data.truncated?' · '+t('큰 파일의 앞부분만 표시해요.'):data.document?' · '+t('문서 내용 미리보기'):data.media?'':' · '+this.language(data.name,data.text||''));
   if(data.media){
    if(!data.data){this.content.append(node('p','미리보기 크기를 초과했어요. 원본을 다운로드해 주세요.'));return;}
    const bytes=Uint8Array.from(atob(data.data),c=>c.charCodeAt(0));this.blob=URL.createObjectURL(new Blob([bytes],{type:data.type}));
    if(data.type==='application/pdf'){const frame=node('iframe');frame.title=data.name;frame.src=this.blob;this.content.append(frame)}else{const image=node('img');image.alt=data.name;image.src=this.blob;this.content.append(image)}return;
   }
   if(data.document){this.document(data);return;}
   if(data.binary){this.content.append(node('p','이 바이너리 형식은 원본을 다운로드해 열어 주세요.'));return;}
   if(!data.truncated&&data.etag)actions.prepend(button('편집',()=>this.edit(), '파일 편집'));
   if(/\.(md|markdown)$/i.test(data.name)){const source=button('소스 보기',()=>{this.code(data.text);source.remove()});actions.prepend(source);const markdown=node('div','','file-markdown');markdown.append(TmuxReader.renderMessages([{id:'file-preview',role:'assistant',text:data.text}],()=>false));this.content.append(markdown);requestAnimationFrame(()=>TmuxReader.fitTables(markdown));}
   else this.code(data.text);
  }
  previewMenu(anchor){this.menu?.remove();const menu=node('div','','file-browser-menu');menu.setAttribute('role','menu');menu.setAttribute('aria-label',t('파일 메뉴'));menu.append(node('strong',this.file.name));const items=[['다운로드',()=>this.download({path:this.file.path,name:this.file.name})],['경로 복사',()=>navigator.clipboard.writeText(this.file.path).catch(()=>this.notice('경로를 복사하지 못했어요.'))]];if(document.body.classList.contains('file-view-window'))items.unshift(['파일 선택',()=>{if(!this.leave())return;this.shell.classList.remove('file-preview-only');this.navigate(this.file?.parent||this.file?.path?.slice(0,this.file.path.lastIndexOf('/'))||'/',false,true)}]);for(const [label,action]of items){const item=button(label,()=>{menu.remove();action()});item.setAttribute('role','menuitem');menu.append(item)}this.menu=menu;document.body.append(menu);const rect=anchor.getBoundingClientRect();menu.style.left=Math.max(6,Math.min(rect.right-menu.offsetWidth,innerWidth-menu.offsetWidth-6))+'px';menu.style.top=Math.max(6,Math.min(rect.bottom+3,innerHeight-menu.offsetHeight-6))+'px';menu.querySelector('button').focus();}
  activateSplit(frame){this.activeFrame=frame;this.previewArea?.querySelectorAll('.file-split-pane').forEach(pane=>pane.classList.toggle('is-active',pane.querySelector('iframe')===frame));this.view.classList.toggle('is-active',!frame);}
  split(axis){if(!this.file)return;const current=this.view,group=node('div','','file-split-group');group.dataset.axis=axis;current.replaceWith(group);const pane=node('section','','file-split-pane'),child=TmuxFileLayout.frame(this),divider=TmuxFileLayout.separator('파일 분할 크기 조절',axis,()=>axis==='x'?current.getBoundingClientRect().width:current.getBoundingClientRect().height,value=>{group.style.setProperty('--file-split-ratio',(value/(axis==='x'?group.clientWidth:group.clientHeight)*100)+'%')},()=>[Math.min(100,(axis==='x'?group.clientWidth:group.clientHeight)*.2),Math.max(100,(axis==='x'?group.clientWidth:group.clientHeight)*.8)]);divider.classList.add('file-split-resizer');pane.append(child.iframe);group.append(current,divider,pane);divider.refresh();child.commit();this.activateSplit(child.iframe);}
  closeSplit(frame){const pane=frame.closest('.file-split-pane'),group=pane?.parentElement;if(!group)return;const child=frame.contentWindow?.TmuxFiles;if(child&&!child.leave(true))return;if(child)child.allowUnload=true;const survivor=[...group.children].find(node=>node!==pane&&!node.classList.contains('file-resizer'));if(survivor)group.replaceWith(survivor);this.activateSplit(null);}
  language(name,text){const extension=name.toLowerCase().split('.').pop();return ({py:'Python',tcl:'Tcl',vim:'Vim',vimrc:'Vim',sh:'Shell',bash:'Bash',bashrc:'Bash',c:'C',h:'C',cc:'C++',cpp:'C++',hpp:'C++',md:'Markdown',json:'JSON',tex:'LaTeX',csv:'CSV'})[extension]||(/\bpython\b/.test(text.split('\n')[0])?'Python':/\bbash\b/.test(text.split('\n')[0])?'Bash':'Text')}
  code(text){this.content.replaceChildren();const code=node('pre','','file-code');TmuxCode.paint(code,text.split('\n').map(text=>({text,runs:[]})),()=>{},{language:this.language(this.file.name,text),diff:false});this.content.append(code)}
  table(rows,labels,merges=[]){const table=node('table');if(labels){const head=node('thead'),row=node('tr');for(const label of labels)row.append(node('th',label));head.append(row);table.append(head)}const spans=new Map(),covered=new Set();for(const [r,c,rowSpan,colSpan]of merges){spans.set(r+','+c,[rowSpan,colSpan]);for(let i=r;i<r+rowSpan;i++)for(let j=c;j<c+colSpan;j++)if(i!==r||j!==c)covered.add(i+','+j)}const body=node('tbody');for(const [r,values]of rows.entries()){const row=node('tr');for(const [c,value]of values.entries()){if(covered.has(r+','+c))continue;const cell=node('td',String(value??'')),span=spans.get(r+','+c);if(span){cell.rowSpan=span[0];cell.colSpan=span[1]}row.append(cell)}body.append(row)}table.append(body);return table}
  slides(data,body){
   // Positions are slide fractions; text sizes are points scaled by the slide's rendered width.
   const deck=node('div','','file-slides'),urls={},font=value=>'calc('+value+' * 100cqw / var(--slide-pt))';body.append(deck);
   // Outlines stretch with their box; non-scaling strokes keep the slide's line width.
   const outline=(d,size,fill,stroke,width,dash)=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS('http://www.w3.org/2000/svg','path');svg.setAttribute('viewBox','0 0 '+size+' '+size);svg.setAttribute('preserveAspectRatio','none');svg.classList.add('file-slide-outline');path.setAttribute('d',d);path.setAttribute('fill',fill||'none');path.setAttribute('stroke',stroke||'none');path.setAttribute('vector-effect','non-scaling-stroke');path.style.strokeWidth=font(width);if(dash)path.style.strokeDasharray=font(width*4)+' '+font(width*3);svg.append(path);return svg};
   const source=key=>{if(!urls[key]){const item=data.images[key];urls[key]=URL.createObjectURL(new Blob([Uint8Array.from(atob(item.data),c=>c.charCodeAt(0))],{type:item.type}));this.blobs.push(urls[key])}return urls[key]};
   for(const [index,slide]of data.slides.entries()){
    const figure=node('figure','','file-slide'),canvas=node('div','','file-slide-canvas');figure.append(node('figcaption',(index+1)+' / '+data.slides.length+(slide.hidden?' · '+t('숨긴 슬라이드'):'')),canvas);
    canvas.style.aspectRatio=data.width+' / '+data.height;canvas.style.background=slide.background;canvas.style.color=data.text_color;canvas.style.setProperty('--slide-pt',data.width/12700);
    for(const item of slide.items){
     const box=node('div','','file-slide-item is-'+item.kind);Object.assign(box.style,{left:item.x*100+'%',top:item.y*100+'%',width:item.w*100+'%',height:item.h*100+'%'});if(item.rotate)box.style.transform='rotate('+item.rotate+'deg)';
     if(item.kind==='image'){const image=node('img');image.alt='';image.src=source(item.media);box.append(image)}
     else if(item.kind==='line'){const [x1,x2]=item.flip_x?[100,0]:[0,100],[y1,y2]=item.flip_y?[100,0]:[0,100];box.append(outline({straight:`M${x1},${y1} L${x2},${y2}`,elbow:`M${x1},${y1} L50,${y1} L50,${y2} L${x2},${y2}`,curve:`M${x1},${y1} C50,${y1} 50,${y2} ${x2},${y2}`}[item.route]||`M${x1},${y1} L${x2},${y2}`,'100',null,item.color,item.width,item.dash))}
     else if(item.kind==='table'){box.style.fontSize=font(item.size);box.append(this.table(item.rows,null,item.merges))}
     else if(item.kind==='missing')box.append(node('span',item.label));
     else{
      Object.assign(box.style,{justifyContent:item.anchor,padding:item.inset.map(value=>value*100+'%').join(' ')});if(item.path)box.append(outline(item.path,'1000',item.fill,item.line,1,item.dash));else Object.assign(box.style,{background:item.fill||'',border:item.line?'1px '+(item.dash?'dashed ':'solid ')+item.line:''});box.dataset.shape=item.shape;
      for(const paragraph of item.paragraphs){const line=node('p');Object.assign(line.style,{textAlign:paragraph.align,fontSize:font(paragraph.size),marginLeft:paragraph.level?font(paragraph.level*27):''});if(paragraph.bullet)line.append(node('span',paragraph.bullet+' ','file-slide-bullet'));for(const run of paragraph.runs){const span=node('span',run.text);Object.assign(span.style,{fontSize:font(run.size),fontWeight:run.bold?'700':'',fontStyle:run.italic?'italic':'',textDecoration:run.underline?'underline':'',color:run.color||''});line.append(span)}if(!line.textContent)line.textContent=' ';box.append(line)}
     }
     canvas.append(box);
    }
    deck.append(figure);
   }
  }
  document(data){
   const body=node('div','','file-document');this.content.append(body);
   if(data.sheets){const select=node('select');select.setAttribute('aria-label',t('엑셀 시트'));for(const [index,sheet]of data.sheets.entries())select.add(new Option(sheet.name,String(index)));const container=node('div','','file-spreadsheet');body.append(select,container);const render=()=>{const sheet=data.sheets[Number(select.value)];container.replaceChildren();if(!sheet)return;const letters=n=>n<26?String.fromCharCode(65+n):String.fromCharCode(64+Math.floor(n/26))+String.fromCharCode(65+n%26);const labels=['',...Array.from({length:sheet.columns},(_,i)=>letters(i))];const rows=sheet.rows.map((values,i)=>[sheet.row_numbers[i],...Array.from({length:sheet.columns},(_,j)=>values[j]??'')]);container.append(this.table(rows,labels));if(sheet.truncated)container.append(node('p','행이 많아 앞 1,000행을 표시해요.'))};select.onchange=render;render();}
   else if(data.slides)this.slides(data,body);
   else{body.classList.add('file-document-page');for(const block of data.blocks||[])body.append(block.rows?this.table(block.rows,null,block.merges):node('p',block.text||'\u00a0'))}
   if(data.truncated_document)body.append(node('p','문서가 길어 앞부분을 표시해요.'));
  }
  edit(){
   if(this.busy||this.editor)return;const editButton=this.view.querySelector('[aria-label="'+CSS.escape(t('파일 편집'))+'"]');if(editButton)editButton.hidden=true;
   this.content.replaceChildren();const editor=node('textarea','','file-editor');editor.value=this.file.text;editor.spellcheck=false;editor.setAttribute('aria-label',t('파일 편집 내용'));this.editor=editor;this.original=editor.value;const bar=node('div','','file-edit-actions');
   const save=button('저장',async()=>{if(this.busy)return;this.busy=true;save.disabled=true;const host=this.host,file=this.file,contents=editor.value;try{const result=await this.api('/api/files',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({host,action:'save',path:file.path,text:contents,etag:file.etag})});file.etag=result.etag;file.text=contents;file.bytes=new TextEncoder().encode(contents).length;this.original=contents;this.status.textContent=t('파일을 저장했어요.')}catch(e){this.status.textContent=e.message}finally{this.busy=false;save.disabled=false}});
   bar.append(node('span',t('Ctrl+S / ⌘S로 저장')),button('편집 닫기',()=>{if(this.leave()){this.editor=null;this.preview(this.file)}}),save);this.content.append(bar,editor);editor.onkeydown=e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();save.click()}else if(e.key==='Tab'){e.preventDefault();editor.setRangeText('  ',editor.selectionStart,editor.selectionEnd,'end')}};editor.focus();
  }
  contextMenu(entry,anchor,event){
   this.menu?.remove();const menu=node('div','','file-browser-menu');menu.setAttribute('role','menu');menu.setAttribute('aria-label',entry.name);menu.append(node('strong',entry.name));
   const items=entry.root?[]:[['다운로드',()=>this.download(entry)]];if(entry.folder&&!this.readOnly)items.push(['파일 첨부',()=>this.chooseFiles(entry)]);if(entry.root)items.push(['다운로드',()=>this.download(entry)]);else items.push(['휴지통으로 이동',()=>this.change('trash',entry)],['영구 삭제',()=>this.change('delete',entry)]);
   for(const [label,action]of items){const item=button(label,()=>{menu.remove();action()});item.setAttribute('role','menuitem');if(label==='영구 삭제')item.className='danger';menu.append(item)}
   this.menu=menu;document.body.append(menu);const rect=anchor.getBoundingClientRect();menu.style.left=Math.max(6,Math.min(event?.clientX??rect.left,innerWidth-menu.offsetWidth-6))+'px';menu.style.top=Math.max(6,Math.min(event?.clientY??rect.bottom,innerHeight-menu.offsetHeight-6))+'px';menu.querySelector('button').focus();
  }
  clearDrop(){this.dropElement?.classList.remove('file-drop-target');this.dropElement=null;if(this.dropHint)this.dropHint.hidden=true;}
  dropTarget(element){const row=element.closest('.file-browser-row');let path=this.directory?.path||'';if(row)path=row.dataset.folder==='true'?row.dataset.path:row.dataset.path.slice(0,row.dataset.path.lastIndexOf('/'))||'/';return {host:this.host,path,name:path.split('/').filter(Boolean).pop()||'/',element:row||this.list};}
  chooseFiles(entry){if(this.readOnly||this.busy||this.trash)return;this.uploadTarget={host:this.host,path:entry.path,name:entry.name};this.uploadInput.click();}
  async uploadFiles(files,target){
   if(this.readOnly||this.busy||this.trash||!files.length)return;this.busy=true;const host=target.host,path=target.path,results=[],errors=[];this.clearDrop();
   try{for(const [index,file]of files.entries()){
    this.status.textContent=t('파일 첨부 중…')+' '+(index+1)+'/'+files.length+' · '+file.name;
    try{const form=new FormData();form.append('file',file,file.name);results.push(await this.api('/api/files/upload?'+new URLSearchParams({host,path,size:file.size}),{method:'POST',body:form}));}catch(error){errors.push(file.name+': '+error.message);}
   }
   if(this.opened&&this.host===host&&!this.trash){
    // Keep the current preview, editor draft, scroll and expanded branches.
    const branches=[...this.tree.branches.entries()].filter(([key,branch])=>(key===path||branch.data?.path===path)&&branch.data),root=this.tree.root;
    if(root?.path===path){const fresh=await this.api(this.url(path,'list',0,true));if(this.opened&&this.host===host&&this.tree.root===root){this.directory=fresh;this.entries=fresh.entries;this.tree.root=fresh;this.tree.render();}}
    for(const [key,branch]of branches){const fresh=await this.api(this.url(key,'list',0,true));if(this.host===host&&this.tree.branches.get(key)===branch){branch.data=fresh;this.tree.render();}}
   }
   this.status.textContent=errors.length?(results.length?results.length+' '+t('파일 첨부 완료')+' · ':'')+errors.join(' / '):results.length+' '+t('파일 첨부 완료');
   }catch(error){this.status.textContent=error.message;}finally{this.busy=false;}
  }
  async download(entry){if(this.busy)return;this.busy=true;this.status.textContent=t('다운로드 준비 중…');try{const response=await fetch(this.url(entry.path,'download'),{credentials:'same-origin'});if(!response.ok)throw Error(await response.text());const blob=URL.createObjectURL(await response.blob()),link=node('a');const match=response.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''(.+)/);link.download=match?decodeURIComponent(match[1]):entry.name;link.href=blob;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(blob),1000);this.status.textContent=t('다운로드를 시작했어요.')}catch(e){this.status.textContent=e.message}finally{this.busy=false}}
  async change(action,entry){
   if(this.busy)return;if(action==='delete'&&!confirm(t('이 항목과 하위 파일을 영구 삭제할까요? 복구할 수 없어요.')+'\n'+this.host+' · '+entry.path))return;
   if(!this.leave())return;
   this.busy=true;this.status.textContent=t(action==='trash'?'휴지통으로 이동 중…':'영구 삭제 중…');try{await this.api('/api/files',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({host:this.host,action,path:entry.path})});if(this.file?.path===entry.path){this.editor=null;this.view.replaceChildren();this.body.classList.remove('show-preview')}await this.navigate(this.directory?.path||'',true,true);this.status.textContent=t(action==='trash'?'휴지통으로 옮겼어요. 설정에서 복원할 수 있어요.':'영구 삭제했어요.')}catch(e){this.status.textContent=e.message}finally{this.busy=false}
  }
  async openTrash(host){if(this.busy||!this.leave())return;this.mount();this.host=host||this.host||this.context().host||this.hosts()[0]?.id;this.editor=null;this.opened=true;this.shell.hidden=false;this.servers.replaceChildren(...this.hosts().map(h=>new Option(h.name,h.id)));this.servers.value=this.host;await this.loadTrash()}
  async loadTrash(){
   const generation=++this.generation;this.tree.reset();this.trash=true;this.location.hidden=true;this.pathForm.hidden=true;this.hidden.disabled=true;this.status.textContent=t('휴지통을 불러오는 중…');this.body.classList.remove('show-preview');this.body.classList.add('is-trash');this.view.replaceChildren();
   try{const data=await this.request(this.url('','trash',0,true));if(generation!==this.generation)return;this.list.replaceChildren();this.list.append(button('‹ 파일로 돌아가기',()=>this.open({host:this.host})));
    for(const entry of data.items){const row=node('div','','file-trash-row');row.append(node('strong',entry.name),node('small',entry.original));const actions=node('div');const run=async action=>{if(this.busy)return;if(action==='purge'&&!confirm(t('휴지통 항목을 영구 삭제할까요?')+'\n'+entry.original))return;this.busy=true;try{await this.api('/api/files',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({host:this.host,action,id:entry.id})});await this.loadTrash()}catch(e){this.status.textContent=e.message}finally{this.busy=false}};const restore=button('복원',()=>run('restore'));restore.disabled=entry.expired;actions.append(restore,button('영구 삭제',()=>run('purge')));row.append(actions);this.list.append(row)}
    this.status.textContent=data.items.length?t('휴지통 · 삭제 후 7일 동안 복원할 수 있어요.'):t('휴지통이 비어 있어요.');
   }catch(e){if(e.name!=='AbortError'&&generation===this.generation)this.status.textContent=e.message}
  }
 }
 window.TmuxFileBrowser=FileBrowser;
})();
