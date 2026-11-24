/* Explicit UI strings are localized; terminal/message payloads are never edited. */
(()=>{
 'use strict';
 const storageKey='q-ui-language',dictionary=globalThis.QEnglish||{};
 const read=()=>{try{return localStorage.getItem(storageKey)==='ko'?'ko':'en'}catch{return 'en'}};
 let language=read();
 const textRecords=new WeakMap(),attributeRecords=new WeakMap();
 const protectedContent='[data-host] strong,[data-session] strong,#reader-content,#terminal,#terminal-history,#reader-interaction,.notification-item strong,.notification-item p,#notification-toast-title,.pending-delivery-preview,.question-title,.question-review,.question-option,.reader-question-set,.chat-message,.chat-file-name,.image-viewer-title,#task-name,#task-path,#input-target,#pane-tabs,.split-panel-title,.navigation-folder-name,.navigation-session-rename,.split-session,.card-name,.card-path,.card-original,.card-eyebrow,.navigation-folder-toggle,#terminal-sessions button,#reader-sessions button,.attachment-list,#host-account,#host-key-info,.run,#nav .title,.file-browser-name,.file-preview-content,.file-browser-path,.file-browser-preview>header strong,.file-trash-row,.file-browser-menu strong,[data-user-content]';
 const extraProtected='.ci .tx,.ci .q,.ci .comment-meta,.ci .rp .hd b,#nav .t,.files [data-file],.head .meta b,.manager-project-name,.paper-server,#projName,#projSel option,table td,table th,.assistant-context,.project-library-name,.q-account-username,.q-account-device span';
 const reverse=new Map();for(const [key,value] of Object.entries(dictionary))if(typeof value==='string'&&value.trim()&&!reverse.has(value))reverse.set(value,key);
 function source(value){if(Object.hasOwn(dictionary,value))return value;return reverse.get(value);}
 function t(value){if(typeof value!=='string'||language==='ko')return value;if(Object.hasOwn(dictionary,value))return dictionary[value];const trimmed=value.trim();return Object.hasOwn(dictionary,trimmed)?value.replace(trimmed,dictionary[trimmed]):value;}
 function f(key,values){return t(key).replace(/\{(\d+)\}/g,(_,index)=>String(values[index]??''));}
 function translate(root){
  if(!root)return;
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT|NodeFilter.SHOW_ELEMENT);
  const visit=node=>{
   const element=node.nodeType===Node.TEXT_NODE?node.parentElement:node;
   if(!element||typeof element.closest!=='function'||element.closest('script,style,pre,code,'+protectedContent+','+extraProtected))return;
   if(node.nodeType===Node.TEXT_NODE){if(element.closest('textarea'))return;const old=textRecords.get(node);if(!node.data.trim()&&!old)return;let record;
    if(old&&node.data===old.last)record=old;
    else{const exact=source(node.data),trimmed=node.data.trim(),key=exact??source(trimmed);if(key!==undefined){const start=exact!==undefined?0:node.data.indexOf(trimmed);record={key,prefix:node.data.slice(0,start),suffix:exact!==undefined?'':node.data.slice(start+trimmed.length)};}}
    if(record){const next=record.prefix+(language==='en'?dictionary[record.key]:record.key)+record.suffix;if(node.data!==next)node.data=next;record.last=node.data;textRecords.set(node,record);}}
   else{for(const attr of ['title','placeholder','aria-label']){if(!node.hasAttribute(attr))continue;const records=attributeRecords.get(node)||{},value=node.getAttribute(attr),old=records[attr],key=old&&old.last===value?old.key:source(value);if(key!==undefined){const last=language==='en'?dictionary[key]:key;node.setAttribute(attr,last);records[attr]={key,last};attributeRecords.set(node,records);}}}
  };
  visit(root);while(walker.nextNode())visit(walker.currentNode);
 }
 function html(value){const template=document.createElement('template');template.innerHTML=value;translate(template.content);return template.innerHTML;}
 // Translate only literal template text. Interpolated manuscript/note data is
 // restored afterward, so even data equal to a UI label remains untouched.
 function parts(quasis,values){
  const marker='Q_LITERAL_VALUE_';
  let value=quasis.map((q,i)=>q+(i<values.length?marker+i+'_END':'')).join('');
  const label=text=>{const indices=[];const key=text.replace(/Q_LITERAL_VALUE_(\d+)_END/g,(_,i)=>'{'+(indices.push(Number(i))-1)+'}');return f(key,indices.map(i=>marker+i+'_END'));};
  value=value.split(/(<[^>]*>)/g).map(piece=>piece.startsWith('<')?piece.replace(/(title|placeholder|aria-label)=(['"])(.*?)\2/g,(_,a,q,s)=>a+'='+q+label(s)+q):label(piece)).join('');
  return value.replace(/Q_LITERAL_VALUE_(\d+)_END/g,(_,i)=>String(values[Number(i)]??''));
 }
 function set(value,persist=true){
  if(!['ko','en'].includes(value)||language===value)return;
  // Record the current UI before switching so both directions remain stable.
  const scopes=[document.body];
  scopes.forEach(translate);language=value;document.documentElement.lang=value;
  if(persist)try{localStorage.setItem(storageKey,value)}catch{}
  scopes.forEach(translate);
  for(const select of document.querySelectorAll('[data-ui-language]'))select.value=value;
  window.dispatchEvent(new CustomEvent('q-language-change',{detail:{language:value}}));
 }
 globalThis.QI18n={t,f,html,parts,translate,set,get language(){return language},get locale(){return language==='en'?'en-US':'ko-KR'}};
 document.documentElement.lang=language;
 window.addEventListener('storage',event=>{if(event.key===storageKey||event.key===null)set(read(),false)});
 document.addEventListener('DOMContentLoaded',()=>translate(document.body),{once:true});
})();
