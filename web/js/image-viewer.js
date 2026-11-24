const qLangImageViewer=globalThis.QI18n||{t:value=>value,html:value=>value,f:(key,values)=>key.replace(/\{(\d+)\}/g,(_,index)=>String(values[index]??'')),locale:'ko-KR'};
/* Originals stay inside the app, including when opened from a split panel. */
(()=>{
 'use strict';
 const stateKey='tmuxImageViewer',entries=new Map();
 const allowed=url=>typeof url==='string'&&(/^\/api\/panes\/[^/?]+\/media\?ref=[a-zA-Z0-9%:._-]+$/.test(url)||/^\/api\/attachments\/[a-f0-9]{32}\/preview$/.test(url));
 const node=(tag,text='',className='')=>{const element=document.createElement(tag);element.textContent=text;element.className=className;return element;};
 let dialog,image,title,stage,message,retry,size,active=null,closing=false;
 function mount(){
  if(dialog)return;
  dialog=node('dialog');dialog.id='image-viewer';dialog.setAttribute('aria-label',qLangImageViewer.t('이미지 원본'));
  const toolbar=node('header','','image-viewer-toolbar'),back=node('button',qLangImageViewer.t('‹ 돌아가기'),'image-viewer-back'),close=node('button',qLangImageViewer.t('닫기 ×'),'image-viewer-close');
  title=node('strong','','image-viewer-title');title.id='image-viewer-title';dialog.setAttribute('aria-labelledby',title.id);
  size=node('button',qLangImageViewer.t('실제 크기'),'image-viewer-size');size.setAttribute('aria-pressed','false');
  for(const button of [back,size,close])button.type='button';back.onclick=closeViewer;close.onclick=closeViewer;
  size.onclick=()=>{const actual=dialog.classList.toggle('is-actual');size.textContent=actual?qLangImageViewer.t('화면 맞춤'):qLangImageViewer.t('실제 크기');size.setAttribute('aria-pressed',String(actual));stage.scrollTop=0;stage.scrollLeft=0;};
  toolbar.append(back,title,size,close);
  stage=node('div','','image-viewer-stage');stage.setAttribute('tabindex','0');stage.setAttribute('aria-label',qLangImageViewer.t('원본 이미지'));
  image=node('img','','image-viewer-image');image.decoding='async';stage.append(image);
  const feedback=node('div','','image-viewer-feedback');message=node('span');message.setAttribute('role','status');retry=node('button',qLangImageViewer.t('다시 불러오기'));retry.type='button';retry.onclick=()=>{if(active)load(active)};feedback.append(message,retry);
  dialog.append(toolbar,stage,feedback);document.body.append(dialog);
  dialog.addEventListener('cancel',event=>{event.preventDefault();closeViewer()});
 }
 function load(entry){
  image.hidden=true;size.disabled=true;retry.hidden=true;message.textContent=qLangImageViewer.t('이미지를 불러오는 중…');
  image.onload=()=>{if(active?.id!==entry.id)return;image.hidden=false;size.disabled=false;message.textContent='';image.style.setProperty('--image-width',image.naturalWidth+'px');image.style.setProperty('--image-height',image.naturalHeight+'px');};
  image.onerror=()=>{if(active?.id!==entry.id)return;image.hidden=true;message.textContent=qLangImageViewer.t('이미지를 불러오지 못했어요. 다시 불러오거나 닫아 주세요.');retry.hidden=false;};
  image.src=entry.url;
 }
 function show(entry){
  mount();active=entry;closing=false;title.textContent=entry.name||qLangImageViewer.t('이미지 원본');image.alt=entry.name||qLangImageViewer.t('이미지 원본');
  dialog.classList.remove('is-actual');size.textContent=qLangImageViewer.t('실제 크기');size.setAttribute('aria-pressed','false');
  if(!dialog.open)dialog.showModal();load(entry);
 }
 function hide(){
  const previous=active;active=null;closing=false;
  if(dialog?.open)dialog.close();if(image){image.onload=null;image.onerror=null;image.removeAttribute('src');}
  if(previous?.opener?.isConnected)previous.opener.focus({preventScroll:true});
 }
 function closeViewer(){
  if(!active||closing)return;
  if(history.state?.[stateKey]===active.id){closing=true;history.back()}else hide();
 }
 function open({url,name},opener){
  if(!allowed(url))return false;
  const entry={id:crypto.randomUUID(),url,name,opener},state={...(history.state&&typeof history.state==='object'?history.state:{}),[stateKey]:entry.id};
  entries.set(entry.id,entry);while(entries.size>8)entries.delete(entries.keys().next().value);
  if(active&&history.state?.[stateKey]===active.id)history.replaceState(state,'',location.href);else history.pushState(state,'',location.href);
  show(entry);return true;
 }
 window.TmuxImageViewer={open,close:closeViewer};
 window.addEventListener('popstate',event=>{const entry=entries.get(event.state?.[stateKey]);if(entry)show(entry);else hide()});
 document.addEventListener('click',event=>{
  const trigger=event.target.closest('[data-image-viewer]');if(!trigger||event.defaultPrevented||event.button>0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
  const value={url:trigger.dataset.imageViewer,name:trigger.dataset.imageName};if(!allowed(value.url))return;
  let viewer=window.TmuxImageViewer;try{if(top.TmuxImageViewer)viewer=top.TmuxImageViewer}catch{}
  if(viewer.open(value,trigger))event.preventDefault();
 });
})();
