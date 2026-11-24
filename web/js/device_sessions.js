const qLangDeviceSessions=globalThis.QI18n||{t:value=>value,html:value=>value,f:(key,values)=>key.replace(/\{(\d+)\}/g,(_,index)=>String(values[index]??'')),locale:'ko-KR'};
/* One saved browser identity per app. No access key is kept in browser storage. */
(()=>{
 'use strict';
 if(parent!==window&&new URLSearchParams(location.search).get('panel')==='1')return;
 const nativeFetch=window.fetch.bind(window),headers={'Content-Type':'application/json'};
 let identifier;try{identifier=localStorage.getItem('tmux-mobile-device-v1')}catch{}
 if(!/^[\w-]{16,80}$/.test(identifier||'')){identifier=crypto.randomUUID();try{localStorage.setItem('tmux-mobile-device-v1',identifier)}catch{}}
 let dialog,button;
 function remember(form){return !!form?.querySelector('[name="remember_device"]')?.checked}
 function loginControls(){
  if(!document.body)return;
  if(!document.getElementById('device-remember-style')){const style=document.createElement('style');style.id='device-remember-style';style.textContent='.device-remember-choice{display:flex!important;align-items:flex-start!important;gap:8px!important;margin:10px 0!important;font:13px/1.5 system-ui!important;text-align:left;cursor:pointer}.device-remember-choice input{display:inline-block!important;flex:none!important;width:16px!important;height:16px!important;min-height:0!important;margin:2px 0 0!important;padding:0!important;accent-color:#89b5d8}.device-remember-choice small{display:block;font-size:11px;color:inherit;opacity:.72;margin:2px 0 0;line-height:1.5}';document.head.append(style)}
  for(const form of document.forms){const key=form.querySelector('input[name="key"],#access-key,#login-key,#appLaunchKey');if(!key||form.querySelector('[name="remember_device"]'))continue;key.autocomplete='off';const label=document.createElement('label');label.className='device-remember-choice';const input=document.createElement('input');input.type='checkbox';input.name='remember_device';const text=document.createElement('span');text.textContent=qLangDeviceSessions.t('이 기기에 로그인 저장');const help=document.createElement('small');help.textContent=qLangDeviceSessions.t('이 앱·브라우저에서만 기억해요. 새 기기는 키가 필요해요.');text.append(help);label.append(input,text);const anchor=key.closest('label')||key;anchor.after(label)}
 }
 function watchLoginControls(){loginControls();new MutationObserver(loginControls).observe(document.body,{childList:true,subtree:true})}
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',watchLoginControls,{once:true});else watchLoginControls();
 const send=(path,body)=>nativeFetch(path,{method:'POST',credentials:'same-origin',headers,body:JSON.stringify(body)});
 const ready=(async()=>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  try{const response=await nativeFetch('/api/device',{method:'POST',credentials:'same-origin',headers,body:JSON.stringify({device_id:identifier}),signal:controller.signal});if(response.ok)mount();return response.ok}catch{return false}finally{clearTimeout(timer)}
 })();
 window.AppDevice={ready,remember};
 window.fetch=(input,options={})=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url,location.href);
  if(url.origin===location.origin&&url.pathname==='/api/login'&&typeof options.body==='string'){
   try{const payload=JSON.parse(options.body),form=document.activeElement?.closest('form')||[...document.forms].find(node=>node.querySelector('input[name="key"],#access-key,#login-key,#appLaunchKey')&&node.getClientRects().length);options={...options,body:JSON.stringify({...payload,remember:typeof payload.remember==='boolean'?payload.remember:remember(form),device_id:identifier})}}catch{}
   return nativeFetch(input,options).then(response=>{if(response.ok)mount();return response});
  }
  return url.origin===location.origin&&url.pathname.startsWith('/api/')&&!['/api/device','/api/devices'].includes(url.pathname)?ready.then(()=>nativeFetch(input,options)):nativeFetch(input,options);
 };
 function mount(){
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',mount,{once:true});return}
  if(button)return;const target=document.querySelector('.paper-actions')||document.querySelector('.appbar .app-actions,.app-header,body>header');if(!target)return;
  const style=document.createElement('style');style.textContent='.app-device-button{flex:none;font-size:11px!important;padding:5px 7px!important;white-space:nowrap}.app-devices{position:fixed;inset:0;margin:auto;width:min(430px,calc(100vw - 24px));max-height:75dvh;padding:18px;border:1px solid #687580;border-radius:10px;background:#15202c;color:#e1e8ed;box-sizing:border-box;overflow:auto;font:13px system-ui}.app-devices::backdrop{background:#0008}.app-devices header{display:flex;align-items:center;justify-content:space-between;position:static;height:auto;padding:0;margin:0 0 12px;background:none}.app-devices h2{font-size:16px;margin:0}.app-devices button{font:inherit;border:1px solid #506477;border-radius:5px;background:#223648;color:#e1e8ed;padding:6px 9px}.app-devices p{font-size:12px;line-height:1.6;color:#aebdca}.app-device-row{display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid #3d4b59}.app-device-row>div{flex:1;min-width:0}.app-device-row strong{display:block;font-size:13px}.app-device-row small{display:block;margin-top:5px;font-size:11px;color:#9aafbd}.app-device-row button{flex:none;font-size:11px}';document.head.append(style);
  button=document.createElement('button');button.type='button';button.className='quiet app-button app-device-button';button.textContent=qLangDeviceSessions.t('기기');button.setAttribute('aria-label',qLangDeviceSessions.t('기기 연결 관리'));button.addEventListener('click',open);target.append(button);
 }
 async function open(){
  if(!dialog){dialog=document.createElement('dialog');dialog.className='app-devices';dialog.setAttribute('aria-label',qLangDeviceSessions.t('기기 연결 관리'));document.body.append(dialog)}
  dialog.replaceChildren();const head=document.createElement('header'),title=document.createElement('h2'),close=document.createElement('button');title.textContent=qLangDeviceSessions.t('기기 연결');close.textContent=qLangDeviceSessions.t('닫기');close.type='button';close.onclick=()=>dialog.close();head.append(title,close);dialog.append(head);
  const help=document.createElement('p');help.textContent=qLangDeviceSessions.t('로그인 저장은 이 앱의 현재 브라우저에만 적용돼요. 새 기기는 접속키를 직접 입력해야 해요.');dialog.append(help);if(!dialog.open)dialog.showModal();
  try{
   const response=await nativeFetch('/api/devices',{credentials:'same-origin',cache:'no-store'});if(!response.ok)throw Error(qLangDeviceSessions.t('기기 목록을 불러오지 못했어요.'));
   const data=await response.json(),current=data.devices.find(item=>item.current);
   const selected=new Set(),choices=[];
   const actions=document.createElement('div');actions.style.cssText='display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0';
   const selectLabel=document.createElement('label');selectLabel.className='device-remember-choice';const selectAll=document.createElement('input');selectAll.type='checkbox';selectLabel.append(selectAll,document.createTextNode(qLangDeviceSessions.t('전체 선택')));
   const disconnectSelected=document.createElement('button');disconnectSelected.type='button';disconnectSelected.textContent=qLangDeviceSessions.t('선택 해제');disconnectSelected.disabled=true;
   const disconnectAll=document.createElement('button');disconnectAll.type='button';disconnectAll.textContent=qLangDeviceSessions.t('전체 해제');disconnectAll.setAttribute('aria-label',qLangDeviceSessions.t('모든 기기 연결 해제'));
   const updateSelection=()=>{disconnectSelected.disabled=!selected.size;disconnectSelected.textContent=selected.size?qLangDeviceSessions.t('선택 해제 (')+selected.size+')':qLangDeviceSessions.t('선택 해제');selectAll.checked=selected.size===data.devices.length&&!!selected.size;selectAll.indeterminate=!!selected.size&&selected.size<data.devices.length};
   selectAll.onchange=()=>{selected.clear();for(const [input,item] of choices){input.checked=selectAll.checked;if(input.checked)selected.add(item.id)}updateSelection()};
   async function disconnect(body){const count=body.all?data.devices.length:selected.size,own=body.all||selected.has(current?.id);if(!confirm(body.all?qLangDeviceSessions.t('이 기기를 포함한 모든 기기의 연결을 해제할까요? 다시 열려면 접속키가 필요해요.'):qLangDeviceSessions.f("선택한 기기 {0}개의 연결을 해제할까요?",[count])+(own?qLangDeviceSessions.t(' 이 기기도 로그아웃돼요.'):'')))return;disconnectSelected.disabled=disconnectAll.disabled=true;try{const response=await send('/api/devices',body);if(!response.ok)throw Error();if((await response.json()).current){try{await window.DeviceSecretStore?.clear()}catch{}location.reload()}else await open()}catch{help.textContent=qLangDeviceSessions.t('연결 해제에 실패했어요. 기기 목록을 다시 열어 확인해 주세요.');disconnectAll.disabled=false;updateSelection()}}
   disconnectSelected.onclick=()=>disconnect({ids:[...selected]});disconnectAll.onclick=()=>disconnect({all:true});actions.append(selectLabel,disconnectSelected,disconnectAll);dialog.append(actions);
   if(current){const label=document.createElement('label');label.className='device-remember-choice';const input=document.createElement('input');input.type='checkbox';input.checked=!!current.remember;label.append(input,document.createTextNode(qLangDeviceSessions.t('이 기기에 로그인 저장')));dialog.append(label);input.onchange=async()=>{const value=input.checked;input.disabled=true;try{const result=await send('/api/device',{device_id:identifier,remember:value});if(!result.ok)throw Error();}catch{input.checked=!value;help.textContent=qLangDeviceSessions.t('저장 설정을 바꾸지 못했어요. 다시 시도해 주세요.')}finally{input.disabled=false}}}
   for(const item of data.devices){
    const row=document.createElement('div');row.className='app-device-row';const text=document.createElement('div'),name=document.createElement('strong'),seen=document.createElement('small'),remove=document.createElement('button');
    const choice=document.createElement('input');choice.type='checkbox';choice.style.cssText='flex:none;width:16px;height:16px;margin:0;accent-color:#89b5d8';choice.setAttribute('aria-label',(item.label||qLangDeviceSessions.t('브라우저'))+(item.current?qLangDeviceSessions.t(' · 이 기기'):'')+qLangDeviceSessions.t(' 선택'));choice.onchange=()=>{if(choice.checked)selected.add(item.id);else selected.delete(item.id);updateSelection()};choices.push([choice,item]);
    name.textContent=(item.label||qLangDeviceSessions.t('브라우저'))+(item.current?qLangDeviceSessions.t(' · 이 기기'):'');seen.textContent=qLangDeviceSessions.t('최근 연결 ')+new Date(item.last_seen*1000).toLocaleString();text.append(name,seen);remove.type='button';remove.textContent=qLangDeviceSessions.t('연결 해제');remove.setAttribute('aria-label',name.textContent+qLangDeviceSessions.t(' 연결 해제'));
    remove.onclick=async()=>{remove.disabled=true;try{const result=await send('/api/devices',{id:item.id});if(!result.ok)throw Error(qLangDeviceSessions.t('연결 해제 실패'));if((await result.json()).current){try{await window.DeviceSecretStore?.clear()}catch{}location.reload()}else open()}catch{remove.textContent=qLangDeviceSessions.t('다시 시도');remove.disabled=false}};row.append(choice,text,remove);dialog.append(row);
   }
  }catch(error){help.textContent=error.message}
 }
})();
