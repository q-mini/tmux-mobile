/* Relay outside presses across this app's same-origin split frames. */
(()=>{
 'use strict';
 const type='q-outside-press';
 function notify(target,point={},source=null){
  document.dispatchEvent(new CustomEvent(type,{detail:{target,...point}}));
  for(const frame of document.querySelectorAll('iframe')){
   if(frame.contentWindow!==source)frame.contentWindow?.postMessage({qOutsidePress:'down'},location.origin);
  }
  if(parent!==window&&source!==parent)parent.postMessage({qOutsidePress:'up'},location.origin);
 }
 document.addEventListener('pointerdown',event=>notify(event.target,{x:event.clientX,y:event.clientY}),true);
 window.addEventListener('message',event=>{
  if(event.origin!==location.origin)return;
  if(event.data?.qOutsidePress==='down'&&parent!==window&&event.source===parent)notify(null,{},parent);
  else if(event.data?.qOutsidePress==='up'){
   const frame=[...document.querySelectorAll('iframe')].find(frame=>frame.contentWindow===event.source);
   if(frame)notify(frame,{},event.source);
  }
 });
})();
