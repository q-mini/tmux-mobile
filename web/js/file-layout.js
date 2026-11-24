/* File-only layout: native pointer resizing and same-origin draft handoff. */
(()=>{
 'use strict';
 const t=value=>window.QI18n?.t(value)??value,pending=new Map();
 function separator(label,axis,read,write,bounds,reverse=false){
  const handle=document.createElement('div');handle.className='file-resizer';handle.tabIndex=0;handle.title=t(label);handle.setAttribute('role','separator');handle.setAttribute('aria-label',t(label));handle.setAttribute('aria-orientation',axis==='x'?'vertical':'horizontal');
  const apply=value=>{const [min,max]=bounds(),next=Math.max(min,Math.min(max,value));write(next);handle.setAttribute('aria-valuemin',String(Math.round(min)));handle.setAttribute('aria-valuemax',String(Math.round(max)));handle.setAttribute('aria-valuenow',String(Math.round(next)));};
  let drag;
  const end=event=>{if(!drag||event.pointerId!==drag.id)return;drag=null;document.documentElement.classList.remove('file-resizing');delete document.documentElement.dataset.fileResize;handle.classList.remove('is-dragging');if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);};
  handle.onpointerdown=event=>{if(event.button!==0)return;event.preventDefault();drag={id:event.pointerId,start:axis==='x'?event.clientX:event.clientY,value:read()};handle.setPointerCapture(event.pointerId);document.documentElement.classList.add('file-resizing');document.documentElement.dataset.fileResize=axis;handle.classList.add('is-dragging');};
  handle.onpointermove=event=>{if(drag?.id!==event.pointerId)return;apply(drag.value+((axis==='x'?event.clientX:event.clientY)-drag.start)*(reverse?-1:1));};
  handle.onpointerup=end;handle.onpointercancel=end;handle.onlostpointercapture=end;
  handle.onkeydown=event=>{const keys=axis==='x'?['ArrowLeft','ArrowRight']:['ArrowUp','ArrowDown'];if(keys.includes(event.key)){event.preventDefault();apply(read()+(event.key===keys[0]?-1:1)*(reverse?-1:1)*(event.shiftKey?40:10));}else if(event.key==='Home'||event.key==='End'){event.preventDefault();apply(bounds()[event.key==='Home'?0:1]);}};
  handle.refresh=()=>{const [min,max]=bounds();handle.setAttribute('aria-valuemin',String(Math.round(min)));handle.setAttribute('aria-valuemax',String(Math.round(max)));handle.setAttribute('aria-valuenow',String(Math.round(Math.max(min,Math.min(max,read())))));};return handle;
 }
 function remember(key,value){try{localStorage.setItem(key,String(value))}catch{}}
 function saved(key){try{const value=Number(localStorage.getItem(key));return Number.isFinite(value)&&value>0?value:null}catch{return null}}
 function mount(browser){
  const {shell,body,list,previewArea}=browser,stored=saved('q-file-panel-width'),tree=saved('q-file-tree-width');if(stored)shell.style.setProperty('--file-panel-width',stored+'px');if(tree)body.style.setProperty('--file-tree-width',tree+'px');
  const outer=separator('파일 창 너비 조절','x',()=>shell.getBoundingClientRect().width,value=>{shell.style.setProperty('--file-panel-width',value+'px');remember('q-file-panel-width',value)},()=>[Math.min(innerWidth,innerWidth<=700?260:360),Math.max(260,innerWidth-(innerWidth<=700?0:36))],true);outer.classList.add('file-panel-resizer');shell.prepend(outer);
  const inner=separator('파일 목록 너비 조절','x',()=>list.getBoundingClientRect().width,value=>{body.style.setProperty('--file-tree-width',value+'px');remember('q-file-tree-width',value)},()=>[Math.min(160,body.clientWidth*.45),Math.max(160,body.clientWidth-157)]);inner.classList.add('file-tree-resizer');body.insertBefore(inner,previewArea);
  browser.resizeObserver=new ResizeObserver(()=>{if(!browser.opened)return;const width=body.clientWidth;if(width>700&&tree)body.style.setProperty('--file-tree-width',Math.max(160,Math.min(saved('q-file-tree-width')||width*.34,width-157))+'px');outer.refresh();inner.refresh();});browser.resizeObserver.observe(shell);
 }
 function transfer(browser){return {host:browser.host,file:structuredClone(browser.file),draft:browser.editor?.value??null};}
 function url(browser,key){const link=new URL('/',location.origin);link.search=new URLSearchParams({'file-view':'1',host:browser.host,path:browser.file.path,transfer:key,...browser.fileQuery?.()});return link;}
 function take(key,source){const item=pending.get(key);if(!item||item.source!==source)return null;pending.delete(key);clearTimeout(item.timer);return structuredClone(item.snapshot);}
 function register(key,source,snapshot){const timer=setTimeout(()=>pending.delete(key),60000);pending.set(key,{source,snapshot,timer});}
 function frame(browser){const key=crypto.randomUUID(),iframe=document.createElement('iframe');iframe.className='file-split-frame';iframe.title=browser.file.name;const snapshot=transfer(browser);iframe.src=url(browser,key).href;return {iframe,commit:()=>register(key,iframe.contentWindow,snapshot)};}
 function detach(browser){if(!browser.file)return;const key=crypto.randomUUID(),snapshot=transfer(browser),popup=window.open(url(browser,key).href,'q-file-'+key,'popup=yes,resizable=yes,width=1000,height=760');if(!popup){browser.notice(t('브라우저에서 이 사이트의 팝업을 허용해 주세요.'));return;}register(key,popup,snapshot);popup.focus();}
 async function start(browser,query){
  document.body.classList.add('file-view-window');if(window.parent!==window)document.body.classList.add('file-view-embedded');
  browser.mount();browser.shell.classList.add('file-preview-only');browser.opened=true;browser.shell.hidden=false;browser.host=query.get('host')||browser.hosts()[0]?.id;browser.servers.replaceChildren(...browser.hosts().map(h=>new Option(h.name,h.id)));browser.servers.value=browser.host;ServerNavigation.paint(browser.shell,browser.host);
  let snapshot;try{const source=window.opener||window.parent;if(source!==window)snapshot=source.TmuxFileLayout?.take(query.get('transfer'),window);}catch{}
  if(snapshot?.file){browser.host=snapshot.host;browser.preview(snapshot.file);if(snapshot.draft!==null){browser.edit();browser.editor.value=snapshot.draft;}}
  else await browser.openFile(query.get('path')||'');
  const announce=()=>{try{if(window.frameElement)parent.TmuxFiles?.activateSplit(window.frameElement)}catch{}};document.addEventListener('pointerdown',announce,true);document.addEventListener('focusin',announce);
 }
 window.TmuxFileLayout={mount,separator,frame,detach,take,start};
})();
