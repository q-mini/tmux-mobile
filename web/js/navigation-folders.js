const qLangNavigationFolders=globalThis.QI18n||{t:value=>value,html:value=>value,f:(key,values)=>key.replace(/\{(\d+)\}/g,(_,index)=>String(values[index]??'')),locale:'ko-KR'};
'use strict';
// Folder organization is shared by authenticated devices; terminal identities stay intact.
window.NavigationFolders=(()=>{
 const key='tmux-navigation-folders-v1',queueKey='tmux-navigation-pending-v2';let menu,menuAnchor,dialog,folderDrag,dragFrame,suppressFolderClick=0,canonical={},view={},revision=-1,busy=false,loaded=false,reported=false;
 const clone=value=>JSON.parse(JSON.stringify(value));
 function stored(name,fallback){try{return JSON.parse(localStorage.getItem(name))||fallback}catch{return fallback}}
 function pending(){const items=stored(queueKey,[]);return Array.isArray(items)?items:[]}
 function enqueue(operation){const items=pending();items.push({id:crypto.randomUUID(),...operation});localStorage.setItem(queueKey,JSON.stringify(items))}
 function apply(all,op){const data=all[op.host]||(all[op.host]={folders:[],sessions:{}});if(op.migrate){if(!Object.hasOwn(canonical,op.host))all[op.host]=clone(op.migrate);return}for(const id of op.remove||[]){const entry=data.folders.find(f=>f.id===id);if(!entry)continue;data.folders=data.folders.filter(f=>f.id!==id);for(const child of data.folders)if(child.parent===id)child.parent=entry.parent;for(const sid of Object.keys(data.sessions))if(data.sessions[sid]===id)data.sessions[sid]=entry.parent}for(const change of op.folders||[]){const entry=data.folders.find(f=>f.id===change.id);if(entry)Object.assign(entry,change);else if(['name','parent','collapsed'].every(field=>Object.hasOwn(change,field)))data.folders.push(clone(change))}for(const [sid,parent] of Object.entries(op.sessions||{})){if(parent===null)delete data.sessions[sid];else data.sessions[sid]=parent}}
 function signature(all){return JSON.stringify(Object.keys(all).sort().map(host=>[host,all[host].folders.map(f=>[f.id,f.parent||'',f.name,!!f.collapsed]),Object.entries(all[host].sessions).sort(([a],[b])=>a.localeCompare(b))]))}
 function rebuild(){const previous=signature(view);view=clone(loaded?canonical:stored(key,{}));for(const op of pending())apply(view,op);if(signature(view)!==previous)window.dispatchEvent(new Event('server-navigation-change'))}
 function read(){return clone(view)}
 function state(host){const all=read(),saved=Object.hasOwn(all,host)?all[host]:null;return saved&&Array.isArray(saved.folders)&&saved.sessions&&typeof saved.sessions==='object'?saved:{folders:[],sessions:{}}}
 function write(host,value){const before=state(host),old=new Map(before.folders.map(f=>[f.id,f])),changes=[];if(!loaded&&stored(key,{})[host]&&!pending().some(op=>op.host===host&&op.migrate))enqueue({host,migrate:before});for(const folder of value.folders){const previous=old.get(folder.id);if(!previous){changes.push(folder);continue}const change={id:folder.id};for(const field of ['name','parent','collapsed'])if(previous[field]!==folder[field])change[field]=folder[field];if(Object.keys(change).length>1)changes.push(change)}const assignments={};for(const sid of new Set([...Object.keys(before.sessions),...Object.keys(value.sessions)]))if(before.sessions[sid]!==value.sessions[sid])Object.defineProperty(assignments,sid,{value:value.sessions[sid]??null,enumerable:true});enqueue({host,folders:changes,remove:before.folders.filter(f=>!value.folders.some(v=>v.id===f.id)).map(f=>f.id),sessions:assignments});rebuild();sync()}
 async function request(method,body){const response=await fetch('/api/navigation',{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,credentials:'same-origin',cache:'no-store'});if(!response.ok){const error=Error(await response.text());error.status=response.status;throw error}return response.json()}
 function accept(data){if(data.revision>=revision){canonical=data.hosts;revision=data.revision;loaded=true;rebuild()}}
 async function sync(){
  if(busy||folderDrag||document.hidden)return;
  busy=true;
  try{
   accept(await request('GET'));
   const legacy=stored(key,{});
   for(const [host,value] of Object.entries(legacy)){
    if(value&&Array.isArray(value.folders)&&value.sessions&&!Object.hasOwn(canonical,host)&&!pending().some(op=>op.host===host&&op.migrate))enqueue({host,migrate:value});
    else if(Object.hasOwn(canonical,host)){delete legacy[host];localStorage.setItem(key,JSON.stringify(legacy))}
   }
   rebuild();
   for(let operations=pending();operations.length;operations=pending()){
    const op=operations[0];
    try{
     const data=await request('POST',op);
     localStorage.setItem(queueKey,JSON.stringify(pending().filter(item=>item.id!==op.id)));
     accept(data);
     if(op.migrate){const remaining=stored(key,{});delete remaining[op.host];localStorage.setItem(key,JSON.stringify(remaining))}
    }catch(error){
     if(error.status===400){localStorage.setItem(queueKey,JSON.stringify(pending().filter(item=>item.id!==op.id)));if(op.migrate){const remaining=stored(key,{});delete remaining[op.host];localStorage.setItem(key,JSON.stringify(remaining))}rebuild()}
     throw error;
    }
   }
   reported=false;
  }catch(error){
   if(error.status!==401&&!reported){reported=true;window.TmuxSessionActions?.notice(error.status===400?error.message:qLangNavigationFolders.t('폴더 변경을 기기에 보관했어요. 연결되면 자동으로 동기화해요.'))}
  }finally{busy=false}
 }
 rebuild();setInterval(sync,3000);window.addEventListener('focus',sync);window.addEventListener('online',sync);document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync()});sync();
 function path(folder,folders){const names=[],seen=new Set();let item=folder;while(item&&!seen.has(item.id)){seen.add(item.id);names.unshift(item.name);item=folders.find(f=>f.id===item.parent)}return names.join(' / ')}
 function descendants(id,folders){const found=new Set([id]);let old;do{old=found.size;for(const f of folders)if(found.has(f.parent))found.add(f.id)}while(old!==found.size);return found}
 function button(text,action){const node=document.createElement('button');node.type='button';node.textContent=text;node.addEventListener('click',action);return node}
 function closeMenu(){menu?.remove();menu=null;menuAnchor=null}
 document.addEventListener('q-outside-press',event=>{const target=event.detail.target;if(menu&&!menu.contains(target)&&!menuAnchor?.contains(target))closeMenu()});
 function fitMenu(){if(!menu||!menuAnchor)return;const viewport=window.visualViewport,left=viewport?.offsetLeft||0,top=viewport?.offsetTop||0,width=viewport?.width||innerWidth,height=viewport?.height||innerHeight;menu.style.maxWidth=Math.max(0,width-12)+'px';menu.style.minWidth=Math.min(142,Math.max(0,width-12))+'px';menu.style.maxHeight=Math.max(0,height-12)+'px';const rect=menuAnchor.getBoundingClientRect(),box=menu.getBoundingClientRect();menu.style.left=Math.max(left+6,Math.min(left+width-box.width-6,rect.right-box.width))+'px';menu.style.top=Math.max(top+6,Math.min(top+height-box.height-6,rect.bottom+3))+'px';}
 window.addEventListener('resize',fitMenu);window.visualViewport?.addEventListener('resize',fitMenu);window.visualViewport?.addEventListener('scroll',fitMenu);
 function popup(anchor,items){
  closeMenu();menu=document.createElement('div');menu.className='navigation-folder-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label',qLangNavigationFolders.t('목록 정리'));
  for(const [name,action] of items){const item=button(name,()=>{closeMenu();action()});item.setAttribute('role','menuitem');menu.append(item)}
  document.body.append(menu);menuAnchor=anchor;fitMenu();menu.firstElementChild.focus({preventScroll:true});
  menu.addEventListener('keydown',event=>{const buttons=[...menu.querySelectorAll('button')],index=buttons.indexOf(document.activeElement);if(event.key==='Escape'){closeMenu();anchor.focus()}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:buttons.length-1))%buttons.length].focus()}});
 }
 function form(title){
  if(dialog?.open)dialog.close();dialog?.remove();dialog=document.createElement('dialog');dialog.className='navigation-folder-dialog';dialog.setAttribute('aria-label',title);
  const head=document.createElement('header'),heading=document.createElement('h2');heading.textContent=title;head.append(heading,button(qLangNavigationFolders.t('닫기'),()=>dialog.close()));const body=document.createElement('form');dialog.append(head,body);document.body.append(dialog);return body;
 }
 function field(form,label,control){const wrap=document.createElement('label'),text=document.createElement('span');text.textContent=label;wrap.append(text,control);form.append(wrap);return control}
 function destination(form,folders,current='',exclude=new Set()){
  const select=document.createElement('select');select.append(new Option(qLangNavigationFolders.t('서버 바로 아래'),''));
  for(const folder of folders.filter(f=>!exclude.has(f.id)).sort((a,b)=>path(a,folders).localeCompare(path(b,folders),'ko')))select.append(new Option(path(folder,folders),folder.id));select.value=current;return field(form,qLangNavigationFolders.t('상위 폴더'),select);
 }
 function edit(host,parent='',id=null){
  const data=state(host),folder=data.folders.find(f=>f.id===id),body=form(folder?qLangNavigationFolders.t('폴더 이름·위치 변경'):qLangNavigationFolders.t('폴더 만들기'));
  const name=document.createElement('input');name.required=true;name.maxLength=80;name.value=folder?.name||'';field(body,qLangNavigationFolders.t('폴더 이름'),name);
  const target=destination(body,data.folders,folder?.parent||parent,folder?descendants(folder.id,data.folders):new Set());
  const status=document.createElement('p');status.setAttribute('role','status');const save=button(folder?qLangNavigationFolders.t('저장'):qLangNavigationFolders.t('만들기'),()=>{});save.type='submit';body.append(status,save);
  body.onsubmit=event=>{event.preventDefault();const title=name.value.trim();if(!title)return;try{const current=state(host);if(current.folders.some(f=>f.id!==id&&f.parent===target.value&&f.name===title))throw Error(qLangNavigationFolders.t('같은 위치에 같은 이름의 폴더가 있어요.'));if(id){const entry=current.folders.find(f=>f.id===id);if(!entry)throw Error(qLangNavigationFolders.t('폴더 목록을 다시 열어 주세요.'));if(descendants(id,current.folders).has(target.value))throw Error(qLangNavigationFolders.t('하위 폴더 안으로 옮길 수 없어요.'));entry.name=title;entry.parent=target.value}else current.folders.push({id:crypto.randomUUID(),parent:target.value,name:title,collapsed:false});write(host,current);dialog.close()}catch(error){status.textContent=error.message}};
  dialog.showModal();name.focus();name.select();
 }
 function renameSession(anchor,session){
  const row=anchor.closest('.navigation-session'),original=row?.querySelector(':scope > button:first-child');if(!original||row.classList.contains('is-renaming'))return;
  const input=document.createElement('input');input.className='navigation-session-rename';input.value=session.name;input.maxLength=60;input.setAttribute('aria-label',session.name+qLangNavigationFolders.t(' 이름 변경'));input.autocomplete='off';input.spellcheck=false;
  row.classList.add('is-renaming');original.hidden=true;anchor.disabled=true;original.after(input);let busy=false,finished=false;
  const finish=()=>{finished=true;row.classList.remove('is-renaming');original.hidden=false;anchor.disabled=false;input.remove();if(original.isConnected)original.focus()};
  const commit=async()=>{if(busy||finished)return;const name=input.value.trim();if(!name||name===session.name){finish();return;}busy=true;input.readOnly=true;try{await window.TmuxSessionActions.rename(session,name);finish()}catch(error){busy=false;input.readOnly=false;input.setAttribute('aria-invalid','true');input.title=error.message;window.TmuxSessionActions.notice(error.message);if(input.isConnected){input.focus();input.select()}}};
  input.addEventListener('pointerdown',event=>event.stopPropagation());input.addEventListener('keydown',event=>{if(event.isComposing)return;if(event.key==='Enter'){event.preventDefault();event.stopPropagation();commit()}else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!busy)finish()}});input.addEventListener('blur',commit);input.focus();input.select();
 }
 function renameServer(anchor,host){
  const row=anchor.closest('.server-group-heading'),original=row?.querySelector('.server-group-toggle');if(!original||row.classList.contains('is-renaming'))return;
  const input=document.createElement('input');input.className='navigation-session-rename';input.value=host.name;input.maxLength=60;input.setAttribute('aria-label',host.name+qLangNavigationFolders.t(' 이름 변경'));input.autocomplete='off';input.spellcheck=false;
  row.classList.add('is-renaming');original.hidden=true;anchor.disabled=true;original.after(input);let busy=false,finished=false;
  const finish=()=>{finished=true;row.classList.remove('is-renaming');original.hidden=false;anchor.disabled=false;input.remove();if(original.isConnected)original.focus()};
  const commit=async()=>{if(busy||finished)return;const name=input.value.trim();if(!name||name===host.name){finish();return;}busy=true;input.readOnly=true;try{await window.TmuxSessionActions.renameHost(host,name);finish()}catch(error){busy=false;input.readOnly=false;input.setAttribute('aria-invalid','true');input.title=error.message;window.TmuxSessionActions.notice(error.message);if(input.isConnected){input.focus();input.select()}}};
  input.addEventListener('pointerdown',event=>event.stopPropagation());input.addEventListener('keydown',event=>{if(event.isComposing)return;if(event.key==='Enter'){event.preventDefault();event.stopPropagation();commit()}else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!busy)finish()}});input.addEventListener('blur',commit);input.focus();input.select();
 }
 function remove(host,id){const data=state(host),folder=data.folders.find(f=>f.id===id);if(!folder||!confirm('“'+folder.name+qLangNavigationFolders.t('” 폴더를 지울까요? 세션과 하위 폴더는 상위 목록으로 옮겨져요.')))return;data.folders=data.folders.filter(f=>f.id!==id);for(const child of data.folders)if(child.parent===id)child.parent=folder.parent;for(const sid of Object.keys(data.sessions))if(data.sessions[sid]===id)data.sessions[sid]=folder.parent;write(host,data)}
 function moveFolder(host,id,parent){const data=state(host),folder=data.folders.find(item=>item.id===id);if(!folder||descendants(id,data.folders).has(parent)||parent&&!data.folders.some(item=>item.id===parent))return false;folder.parent=parent;write(host,data);return true}
 function raiseFolder(host,id){const data=state(host),folder=data.folders.find(item=>item.id===id),parent=data.folders.find(item=>item.id===folder?.parent);if(folder)moveFolder(host,id,parent?.parent||'')}
 function startFolderDrag(toggle,host,id,event,touch=false){
  if(folderDrag||!touch&&(event.button!==0||event.pointerType==='touch'))return;const point=touch?event.touches[0]:event;if(touch&&event.touches.length!==1)return;
  folderDrag={host,id,toggle,touch,pointer:event.pointerId,x:point.clientX,y:point.clientY,startX:point.clientX,startY:point.clientY,sidebar:toggle.closest('.split-sidebar')||toggle.closest('nav')};
  folderDrag.timer=setTimeout(activateFolderDrag,400);
 }
 function activateFolderDrag(){
  const drag=folderDrag;if(!drag||drag.active)return;drag.active=true;closeMenu();const layer=document.createElement('div');layer.className='navigation-folder-drag-layer';const hint=document.createElement('span');hint.className='navigation-folder-drag-hint';hint.textContent=qLangNavigationFolders.t('폴더나 서버 이름 위에 놓아 이동');layer.append(hint);document.body.append(layer);drag.layer=layer;drag.hint=hint;suppressFolderClick=Date.now()+1000;trackFolderDrag(drag.x,drag.y);scrollFolderDrag();
 }
 function trackFolderDrag(x,y){
  const drag=folderDrag;if(!drag?.active)return;drag.x=x;drag.y=y;const target=dropTarget({host:drag.host},x,y,drag.sidebar||document.body);
  if(target&&target.valid&&descendants(drag.id,state(drag.host).folders).has(target.folder)){target.valid=false;target.label=qLangNavigationFolders.t('자기 자신이나 하위 폴더 안으로 옮길 수 없어요.');}
  drag.target=target;drag.hint.textContent=target?.label||qLangNavigationFolders.t('폴더나 서버 이름 위에 놓아 이동');
 }
 function scrollFolderDrag(){
  const drag=folderDrag;if(!drag?.active)return;const area=drag.sidebar?.querySelector('nav')||drag.sidebar,rect=area?.getBoundingClientRect();if(rect&&drag.x>=rect.left&&drag.x<=rect.right){const delta=drag.y<rect.top+30?-6:drag.y>rect.bottom-30?6:0;if(delta){area.scrollTop+=delta;trackFolderDrag(drag.x,drag.y);}}dragFrame=requestAnimationFrame(scrollFolderDrag);
 }
 function finishFolderDrag(commit){
  const drag=folderDrag;if(!drag)return;folderDrag=null;clearTimeout(drag.timer);cancelAnimationFrame(dragFrame);drag.layer?.remove();clearDrop();
  if(drag.active){suppressFolderClick=Date.now()+500;if(commit&&drag.target?.valid)try{moveFolder(drag.host,drag.id,drag.target.folder)}catch(error){window.TmuxSessionActions?.notice(error.message)}}
 }
 document.addEventListener('pointermove',event=>{const drag=folderDrag;if(!drag||drag.touch||event.pointerId!==drag.pointer)return;if(!drag.active&&Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)>7)activateFolderDrag();if(drag.active){event.preventDefault();trackFolderDrag(event.clientX,event.clientY)}},{passive:false});
 document.addEventListener('pointerup',event=>{if(folderDrag&&!folderDrag.touch&&event.pointerId===folderDrag.pointer)finishFolderDrag(true)});
 document.addEventListener('pointercancel',()=>{if(folderDrag&&!folderDrag.touch)finishFolderDrag(false)});
 document.addEventListener('touchmove',event=>{const drag=folderDrag;if(!drag?.touch)return;const point=event.touches[0];if(!point||event.touches.length!==1){finishFolderDrag(false);return;}if(!drag.active&&Math.hypot(point.clientX-drag.startX,point.clientY-drag.startY)>8){finishFolderDrag(false);return;}if(drag.active){event.preventDefault();trackFolderDrag(point.clientX,point.clientY)}},{passive:false});
 document.addEventListener('touchend',()=>{if(folderDrag?.touch)finishFolderDrag(true)});document.addEventListener('touchcancel',()=>{if(folderDrag?.touch)finishFolderDrag(false)});
 document.addEventListener('touchstart',event=>{if(event.touches.length>1)finishFolderDrag(false)},{capture:true,passive:true});
 document.addEventListener('click',event=>{if(Date.now()<suppressFolderClick&&event.target.closest('.split-sidebar')){event.preventDefault();event.stopImmediatePropagation()}},true);
 document.addEventListener('contextmenu',event=>{if(event.target.closest('.navigation-folder-toggle'))event.preventDefault()});
 function decorate(section,host){section.dataset.folderHost=host.id;queueMicrotask(()=>render(section))}
 function clearDrop(){for(const node of document.querySelectorAll('.navigation-folder-drop'))node.classList.remove('navigation-folder-drop')}
 function dropTarget(session,x,y,scope){
  clearDrop();if(!session)return null;
  const targets=[...scope.querySelectorAll('.server-group-heading,.navigation-folder-heading,.navigation-session')];
  for(const node of targets){const rect=node.getBoundingClientRect();if(!rect.width||!rect.height||x<rect.left||x>rect.right||y<rect.top||y>rect.bottom)continue;
   const server=node.closest('[data-folder-host]'),host=server?.dataset.folderHost;if(!host)continue;const valid=host===(session.host||'local'),folder=node.closest('.navigation-folder')?.dataset.folder||'',data=state(host),entry=data.folders.find(f=>f.id===folder);node.classList.add('navigation-folder-drop');return {kind:'folder',host,folder,valid,label:valid?(entry?path(entry,data.folders):qLangNavigationFolders.t('서버 바로 아래'))+qLangNavigationFolders.t('로 이동'):qLangNavigationFolders.t('같은 서버의 폴더로 옮겨 주세요'),rect};
  }return null;
 }
 function drop(session,target){if(!target.valid||target.host!==(session.host||'local'))return false;const data=state(target.host);if(target.folder&&!data.folders.some(f=>f.id===target.folder))return false;Object.defineProperty(data.sessions,session.id,{value:target.folder,enumerable:true,configurable:true,writable:true});write(target.host,data);return true}
 function render(section){
  const root=section.querySelector(':scope > .server-group-items');if(!root)return;const host=section.dataset.folderHost||section.dataset.host,data=state(host),rows=[...root.querySelectorAll('.navigation-session')];
  root.replaceChildren();const containers=new Map([['',root]]),pending=[...data.folders],seen=new Set();
  for(let pass=0;pending.length&&pass<=data.folders.length;pass++)for(let at=0;at<pending.length;){const folder=pending[at],parent=containers.get(folder.parent||'');if(!parent||seen.has(folder.id)){at++;continue}pending.splice(at,1);seen.add(folder.id);
   const group=document.createElement('section');group.className='navigation-folder';group.dataset.folder=folder.id;const heading=document.createElement('div');heading.className='navigation-folder-heading';const toggle=button('',()=>{const current=state(host),entry=current.folders.find(f=>f.id===folder.id);if(entry){entry.collapsed=!entry.collapsed;write(host,current)}});toggle.className='navigation-folder-toggle';toggle.setAttribute('aria-expanded',String(!folder.collapsed));
   const arrow=document.createElement('span');arrow.className='navigation-folder-chevron';arrow.setAttribute('aria-hidden','true');arrow.innerHTML='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6 4 4 4-4"/></svg>';const label=document.createElement('span');label.textContent=folder.name;label.className='navigation-folder-name';toggle.title=path(folder,data.folders);toggle.append(arrow,label);
   toggle.addEventListener('pointerdown',event=>startFolderDrag(toggle,host,folder.id,event));toggle.addEventListener('touchstart',event=>startFolderDrag(toggle,host,folder.id,event,true),{passive:true});
   const more=button('⋯',()=>popup(more,[[qLangNavigationFolders.t('하위 폴더 만들기'),()=>edit(host,folder.id)],[qLangNavigationFolders.t('이름·위치 변경'),()=>edit(host,'',folder.id)],...(folder.parent?[[qLangNavigationFolders.t('상위로 꺼내기'),()=>raiseFolder(host,folder.id)]]:[]),[qLangNavigationFolders.t('폴더 지우기'),()=>remove(host,folder.id)]]));more.className='navigation-more';more.setAttribute('aria-label',folder.name+qLangNavigationFolders.t(' 폴더 메뉴'));heading.append(toggle,more);
   const children=document.createElement('div');children.className='navigation-folder-items';children.hidden=!!folder.collapsed;children.id='nav-folder-'+crypto.randomUUID();toggle.setAttribute('aria-controls',children.id);group.append(heading,children);parent.append(group);containers.set(folder.id,children);
  }
  for(const row of rows){const destination=Object.hasOwn(data.sessions,row.dataset.session)?data.sessions[row.dataset.session]:'';(containers.get(destination)||root).append(row)}
  for(const folder of root.querySelectorAll('.navigation-folder'))folder.classList.toggle('contains-current',!!folder.querySelector('[aria-current=true]'));
 }
 document.addEventListener('pointerdown',event=>{if(menu&&!menu.contains(event.target))closeMenu()});document.addEventListener('keydown',event=>{if(event.key==='Escape'){closeMenu();finishFolderDrag(false)}});window.addEventListener('resize',()=>{closeMenu();finishFolderDrag(false)});
 window.addEventListener('storage',event=>{if(event.key===queueKey){rebuild();sync()}});window.addEventListener('server-navigation-change',()=>queueMicrotask(()=>{if(folderDrag)return;for(const section of document.querySelectorAll('[data-folder-host]'))render(section)}));
 return {decorate,dropTarget,drop,clearDrop,get dragging(){return !!folderDrag},get ready(){return loaded},get revision(){return revision},serverMenu:(anchor,host,manage)=>popup(anchor,[[qLangNavigationFolders.t('tmux 추가'),()=>window.TmuxSessionActions.add(host)],[qLangNavigationFolders.t('폴더 만들기'),()=>edit(host.id)],[qLangNavigationFolders.t('파일 보기'),()=>window.TmuxOpenFiles?.({host:host.id})],[qLangNavigationFolders.t('이름 변경'),()=>renameServer(anchor,host)],[qLangNavigationFolders.t('서버 관리'),manage]]),sessionMenu:(anchor,session)=>popup(anchor,[[qLangNavigationFolders.t('이름 변경'),()=>renameSession(anchor,session)],[qLangNavigationFolders.t('삭제'),()=>window.TmuxSessionActions.remove(session)]]),state};
})();
