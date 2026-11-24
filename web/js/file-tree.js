/* Lazy, server-scoped tree. Only explicit expansion reads a child directory. */
(()=>{
 'use strict';
 const t=value=>window.QI18n?.t(value)??value;
 const element=(tag,cls='',text='')=>{const node=document.createElement(tag);node.className=cls;node.textContent=text;return node};
 const paths={
  folder:'<path d="M2 6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z"/>',
  open:'<path d="M2 11V6a2 2 0 0 1 2-2h5l2 2h8a2 2 0 0 1 2 2v3M4 11h18l-3 10H2Z"/>',
  code:'<path d="m8 8-4 4 4 4m8-8 4 4-4 4m-3-11-2 14"/>',
  document:'<path d="M14 2H5v20h14V7Zm0 0v5h5M8 12h8m-8 4h6"/>',
  table:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16m6-10v10M3 15h18"/>',
  image:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
  markdown:'<path d="M3 18V6l5 6 5-6v12m3-5 3 4 3-4m-3 3V6"/>',
  chevron:'<path d="m9 5 7 7-7 7"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
 };
 function icon(kind){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.5');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('aria-hidden','true');svg.innerHTML=paths[kind]||paths.document;return svg;}
 function fileKind(entry){if(entry.folder)return 'folder';const suffix=entry.name.toLowerCase().split('.').pop();return /^(py|tcl|sh|bash|c|h|cc|cpp|hpp|js|ts|jsx|tsx|vim|vimrc|json|yaml|yml|tex)$/.test(suffix)?'code':/^(xlsx|xlsm|xls|csv|tsv)$/.test(suffix)?'table':/^(png|jpg|jpeg|gif|webp|svg|avif)$/.test(suffix)?'image':/^(md|markdown)$/.test(suffix)?'markdown':suffix==='pdf'?'pdf':'document';}
 const size=bytes=>bytes==null?'':bytes<1024?bytes+' B':bytes<1024**2?(bytes/1024).toFixed(1)+' KB':(bytes/1024**2).toFixed(1)+' MB';
 let serial=0;
 class FileTree{
  constructor(container,{load,open,preview,menu,update}){Object.assign(this,{container,load,open,preview,menu,update});this.epoch=0;this.branches=new Map();this.controllers=new Set();this.query='';this.selected='';}
  reset(){this.epoch++;for(const controller of this.controllers)controller.abort();this.controllers.clear();this.branches.clear();this.root=null;this.selected='';this.query='';this.tap=null;this.container.replaceChildren();}
  setRoot(root){this.reset();this.root=root;
   const heading=element('div','file-tree-heading'),label=element('strong','file-tree-root',root.name||'/');label.setAttribute('data-user-content','');label.title=root.path;heading.append(icon('folder'),label);this.count=element('span','file-tree-count');heading.append(this.count);const more=element('button','file-tree-root-more','⋯');more.type='button';more.setAttribute('aria-label',t('현재 폴더 메뉴'));more.setAttribute('aria-haspopup','menu');more.onclick=event=>this.menu({...root,folder:true,root:true},event.currentTarget);heading.append(more);
   const search=element('label','file-tree-search');search.append(icon('search'));this.search=element('input');this.search.type='search';this.search.placeholder=t('파일 이름 검색');this.search.setAttribute('aria-label',t('파일 목록 검색'));this.search.oninput=()=>{this.query=this.search.value.toLocaleLowerCase();this.render()};search.append(this.search);
   this.rows=element('div','file-browser-rows');this.rows.setAttribute('role','tree');this.rows.setAttribute('aria-label',root.name||'/');this.rows.onkeydown=event=>this.key(event);
   this.container.append(heading,search,this.rows);this.render();
  }
  select(path){this.selected=path;for(const row of this.rows?.querySelectorAll('.file-browser-row')||[]){const selected=row.dataset.path===path;row.classList.toggle('is-selected',selected);row.querySelector('.file-browser-entry').setAttribute('aria-selected',String(selected));}}
  matches(entry,seen=new Set()){if(entry.name.toLocaleLowerCase().includes(this.query))return true;if(seen.has(entry.path))return false;seen.add(entry.path);return (this.branches.get(entry.path)?.data?.entries||[]).some(child=>this.matches(child,seen));}
  render(){
   if(!this.root)return;const focus=document.activeElement,focusPath=focus?.closest('.file-browser-row')?.dataset.path,focusToggle=focus?.classList.contains('file-browser-toggle'),scroll=this.container.scrollTop;
   this.rows.replaceChildren();this.count.textContent=this.root.entries.length+(this.root.more?'+':'');
   for(const entry of this.root.entries)if(!this.query||this.matches(entry))this.rows.append(this.entry(entry,0,new Set([this.root.path])));
   if(!this.rows.childElementCount)this.rows.append(element('p','file-browser-empty',t(this.query?'펼친 목록에 일치하는 파일이 없어요.':'이 폴더는 비어 있어요.')));
   if(this.root.more)this.rows.append(this.more(this.root));
   if(focusPath){const row=[...this.rows.querySelectorAll('.file-browser-row')].find(row=>row.dataset.path===focusPath);row?.querySelector(focusToggle?'.file-browser-toggle':'.file-browser-entry')?.focus({preventScroll:true})}
   this.container.scrollTop=scroll;
  }
  entry(entry,depth,ancestors){
   const branch=this.branches.get(entry.path),expanded=!!branch?.open||!!this.query&&!!branch?.data&&this.matches(entry),wrapper=element('div','file-tree-node'),row=element('div','file-browser-row');wrapper.setAttribute('role','none');row.dataset.path=entry.path;row.dataset.folder=String(!!entry.folder);wrapper.append(row);
   if(entry.folder){const toggle=element('button','file-browser-toggle');toggle.type='button';toggle.append(icon('chevron'));toggle.setAttribute('aria-label',entry.name+' '+t(expanded?'접기':'펼치기'));toggle.setAttribute('aria-expanded',String(expanded));toggle.onclick=()=>this.toggle(entry);row.append(toggle)}
   else row.append(element('span','file-tree-spacer'));
   const kind=fileKind(entry),open=element('button','file-browser-entry file-kind-'+kind);open.type='button';open.title=entry.path;open.setAttribute('role','treeitem');open.setAttribute('aria-level',String(depth+1));open.setAttribute('aria-selected',String(entry.path===this.selected));if(entry.folder)open.setAttribute('aria-expanded',String(expanded));
   const glyph=element('span','file-browser-icon');glyph.append(icon(entry.folder?(expanded?'open':'folder'):kind));open.append(glyph,element('span','file-browser-name',entry.name));if(entry.link){const link=element('span','file-tree-link','↗');link.title=t('심볼릭 링크');open.append(link)}if(!entry.folder)open.append(element('small','file-tree-size',size(entry.bytes)));
   open.onclick=event=>{if(entry.folder){this.select(entry.path);if(event.detail===0)this.enter(entry)}else this.preview(entry)};
   if(entry.folder){open.onkeydown=event=>{if(event.key===' '){event.preventDefault();this.select(entry.path)}};open.ondblclick=event=>{event.preventDefault();this.enter(entry)};open.onpointerup=event=>{if(event.pointerType!=='touch')return;const now=performance.now();if(this.tap?.path===entry.path&&now-this.tap.time<450){this.tap=null;event.preventDefault();this.enter(entry)}else this.tap={path:entry.path,time:now}};}
   const more=element('button','file-browser-more','⋯');more.type='button';more.setAttribute('aria-label',entry.name+' '+t('메뉴'));more.setAttribute('aria-haspopup','menu');more.onclick=event=>{this.select(entry.path);this.menu(entry,event.currentTarget)};
   row.classList.toggle('is-selected',entry.path===this.selected);row.append(open,more);row.oncontextmenu=event=>{event.preventDefault();this.select(entry.path);this.menu(entry,row,event)};
   if(entry.folder&&expanded){
    const children=element('div','file-tree-children');children.id='file-children-'+(++serial);children.setAttribute('role','group');open.setAttribute('aria-owns',children.id);row.querySelector('.file-browser-toggle').setAttribute('aria-controls',children.id);wrapper.append(children);
    const cycle=branch?.data&&ancestors.has(branch.data.path);
    if(cycle||depth>=30)children.append(element('p','file-tree-note',t('더블클릭해서 이 폴더를 열 수 있어요.')));
    else if(branch?.data){const next=new Set(ancestors);next.add(branch.data.path);for(const child of branch.data.entries)if(!this.query||entry.name.toLocaleLowerCase().includes(this.query)||this.matches(child))children.append(this.entry(child,depth+1,next));if(branch.data.more)children.append(this.more(branch.data,entry));if(!children.childElementCount)children.append(element('p','file-tree-note',t('빈 폴더')));}
    if(branch?.loading){const note=element('p','file-tree-note',t('불러오는 중…'));note.setAttribute('role','status');children.append(note)}
    if(branch?.error){const retry=element('button','file-tree-retry',t('다시 시도'));retry.type='button';retry.title=branch.error;retry.onclick=()=>this.fetch(entry,branch);children.append(element('p','file-tree-note is-error',branch.error),retry)}
   }
   return wrapper;
  }
  async enter(entry){if(this.entering===entry.path)return;this.entering=entry.path;try{await this.open(entry)}finally{this.entering='';}}
  toggle(entry){let branch=this.branches.get(entry.path);if(!branch){branch={open:true};this.branches.set(entry.path,branch)}else branch.open=!branch.open;this.render();if(branch.open&&!branch.data&&!branch.loading)this.fetch(entry,branch);}
  async fetch(entry,branch,offset=0){
   const epoch=this.epoch,controller=new AbortController();this.controllers.add(controller);branch.loading=true;branch.error='';this.render();
   try{const data=await this.load(entry.path,offset,controller.signal);if(epoch!==this.epoch)return;if(data.kind!=='directory')throw Error(t('폴더를 읽을 수 없어요.'));branch.data=offset?{...data,entries:[...branch.data.entries,...data.entries]}:data;}
   catch(error){if(epoch===this.epoch&&error.name!=='AbortError')branch.error=error.message;}
   finally{this.controllers.delete(controller);if(epoch===this.epoch){branch.loading=false;this.render()}}
  }
  more(data,entry=null){
   const button=element('button','file-browser-load-more',t('더 보기'));button.type='button';button.onclick=async()=>{button.disabled=true;if(entry){const branch=this.branches.get(entry.path);if(!branch.loading)await this.fetch(entry,branch,branch.data.entries.length);return;}
    const epoch=this.epoch,controller=new AbortController();this.controllers.add(controller);
    try{const next=await this.load(data.path,data.entries.length,controller.signal);if(epoch!==this.epoch)return;this.root={...next,entries:[...this.root.entries,...next.entries]};this.update(this.root);this.render()}
    catch(error){if(epoch===this.epoch&&error.name!=='AbortError'){button.textContent=t('다시 시도');button.title=error.message;button.disabled=false}}
    finally{this.controllers.delete(controller)}
   };return button;
  }
  key(event){
   const target=event.target.closest('.file-browser-entry');if(!target)return;const row=target.closest('.file-browser-row'),wrapper=row.parentElement,folder=row.dataset.folder==='true';
   if(event.key==='ArrowRight'&&folder){event.preventDefault();if(target.getAttribute('aria-expanded')==='false')row.querySelector('.file-browser-toggle').click();else wrapper.querySelector('.file-tree-children .file-browser-entry')?.focus();}
   else if(event.key==='ArrowLeft'){event.preventDefault();if(folder&&target.getAttribute('aria-expanded')==='true')row.querySelector('.file-browser-toggle').click();else wrapper.parentElement.closest('.file-tree-node')?.querySelector('.file-browser-entry')?.focus();}
   else if(['ArrowUp','ArrowDown','Home','End'].includes(event.key)){event.preventDefault();const entries=[...this.rows.querySelectorAll('.file-browser-entry')],index=entries.indexOf(target);entries[event.key==='Home'?0:event.key==='End'?entries.length-1:Math.max(0,Math.min(entries.length-1,index+(event.key==='ArrowUp'?-1:1)))]?.focus();}
  }
 }
 window.TmuxFileTree=FileTree;
 window.TmuxFileIcon=icon;
})();
