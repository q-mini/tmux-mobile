/* Common account UI. Passwords and recovery codes never enter browser storage. */
(()=>{
 'use strict';
 const t=value=>globalThis.QI18n?.t(value)??value;
 const passwordHint='10자 이상 · 영문·숫자·특수문자 포함';
 function newPassword(input){input.minLength=10;input.maxLength=1024;input.pattern='(?=.*[A-Za-z])(?=.*[0-9])(?=.*[\\x21-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\x7e]).{10,1024}';input.title=t(passwordHint);}
 const node=(tag,text='',className='')=>{const n=document.createElement(tag);n.textContent=t(text);n.className=className;return n};
 const button=(text,action,className='')=>{const n=node('button',text,className);n.type='button';n.onclick=action;return n};
 function field(parent,title,type='text',autocomplete='off'){const label=node('label',title),input=node('input');input.type=type;input.autocomplete=autocomplete;input.setAttribute('aria-label',t(title));label.append(input);parent.append(label);return input;}
 function device(){try{return localStorage.getItem('tmux-mobile-device-v1')||undefined}catch{return undefined}}
 async function request(body){const response=await fetch('/api/account',{credentials:'same-origin',cache:'no-store',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});let value;try{value=await response.json()}catch{value={error:'계정 서버에 연결하지 못했어요.'}}if(!response.ok){const error=Error(t(value.error||value.err||'요청을 완료하지 못했어요.'));error.status=response.status;throw error;}return value;}
 function recovery(parent,value,next){parent.replaceChildren(node('p','복구 코드를 안전한 곳에 보관해 주세요. 비밀번호를 잊었을 때 필요하며, 다시 표시되지 않아요.'));const code=node('code',value,'q-recovery-code');parent.append(code,button('복구 코드 복사',()=>navigator.clipboard.writeText(value)),button('확인하고 계속',next,'primary'));}
 function dialog(title){const d=node('dialog','','q-account-dialog'),head=node('header'),h=node('h2',title);head.append(h,button('닫기',()=>d.close()));d.append(head);document.body.append(d);d.addEventListener('close',()=>{d.querySelectorAll('input').forEach(input=>input.value='');d.remove()},{once:true});d.showModal();return d;}
 function authBox(legacy,{setup=false,initial='login'}={}){
  if(legacy.dataset.accountMounted)return;legacy.dataset.accountMounted='1';const host=node('section','','q-account-login');host.dataset.setup=String(setup);legacy.before(host);const brand=legacy.querySelector('.login-brand');if(brand)host.append(brand);if(legacy.classList.contains('login-card')){host.classList.add('login-card');legacy.classList.remove('login-card');}
  const tabs=node('div','','q-account-tabs'),body=node('div'),status=node('p','','q-account-status'),account=node('section','','q-account-section'),old=node('section','','q-key-login');status.setAttribute('role','status');account.append(node('h2',setup?'계정 설정':'계정이 있다면 로그인'),tabs,body,status);old.append(node('h2','처음이라면 접속키로 시작'),node('p','키로 접속한 뒤 설정에서 ID와 비밀번호를 만들 수 있어요.'),legacy);host.append(old,account);old.hidden=setup;
  let appKey=legacy.querySelector('input[name=key],#access-key,#login-key,#appLaunchKey');
  if(!appKey)appKey=field(old,'접속키','password');
  else if(!appKey.closest('label')&&!legacy.querySelector('label[for="'+appKey.id+'"]')){const label=node('label','접속키');appKey.before(label);label.append(appKey);}
  appKey.autocomplete='off';
  if(legacy.id==='appLaunchLogin'){host.hidden=legacy.hidden;new MutationObserver(()=>host.hidden=legacy.hidden).observe(legacy,{attributes:true,attributeFilter:['hidden']});}
  function render(mode){
   body.replaceChildren();status.textContent='';for(const b of tabs.children)b.setAttribute('aria-pressed',String(b.dataset.mode===mode));
   const form=node('form','','q-account-form'),username=field(form,'ID','text','username');username.required=true;username.pattern='[A-Za-z0-9][A-Za-z0-9_.-]{2,39}';username.maxLength=40;username.autocapitalize='none';username.spellcheck=false;
   const password=field(form,mode==='reset'?'새 비밀번호':'비밀번호','password',mode==='login'?'current-password':'new-password');password.required=true;password.maxLength=1024;if(mode!=='login')newPassword(password);
   let repeat,code;
   if(mode!=='login'){repeat=field(form,'비밀번호 확인','password','new-password');repeat.required=true;form.append(node('small',passwordHint));}
   if(mode==='register')form.append(node('small','다음부터는 이 ID와 비밀번호로 로그인할 수 있어요.'));
   if(mode==='reset'){code=field(form,'복구 코드','password');code.required=true;}
   const rememberLabel=node('label','','q-account-remember'),remember=node('input');remember.type='checkbox';rememberLabel.append(remember,document.createTextNode(t('이 기기에 로그인 저장')));if(mode!=='reset')form.append(rememberLabel);
   const submit=node('button',mode==='register'?'계정 만들기':mode==='reset'?'비밀번호 재설정':'로그인','primary');submit.type='submit';form.append(submit);body.append(form);
   form.onsubmit=async event=>{event.preventDefault();if(repeat&&password.value!==repeat.value){status.textContent=t('비밀번호가 서로 달라요.');repeat.focus();return;}
    const payload={action:mode,username:username.value,password:password.value,key:mode==='reset'?'':appKey.value,recovery_code:code?.value||'',device_id:device(),remember:remember.checked};form.querySelectorAll('input[type=password]').forEach(input=>input.value='');if(mode!=='reset')appKey.value='';submit.disabled=true;status.textContent=t('확인 중…');
    try{const result=await request(payload);status.textContent='';if(result.recovery_code)recovery(body,result.recovery_code,()=>location.reload());else location.reload();}
    catch(error){status.textContent=error.message;if(error.status===403&&mode==='login')appKey.focus()}
    finally{payload.password=payload.key=payload.recovery_code='';submit.disabled=false;}
   };
  }
  for(const [mode,label]of (setup?[['register','계정 만들기'],['login','기존 계정 연결']]:[['login','로그인'],['reset','비밀번호 재설정']])){const b=button(label,()=>render(mode));b.dataset.mode=mode;tabs.append(b)}render(initial);
 }
 async function manage(action,refresh){
  const title=({password:'비밀번호 변경',recovery:'복구 코드 재발급',username:'ID 변경',delete:'계정 삭제'})[action],d=dialog(title),form=node('form','','q-account-form');d.append(form);
  const current=field(form,'현재 비밀번호','password','current-password');current.required=true;let value,repeat;
  if(action==='password'){value=field(form,'새 비밀번호','password','new-password');value.required=true;newPassword(value);repeat=field(form,'비밀번호 확인','password','new-password');repeat.required=true;form.append(node('small',passwordHint),node('small','비밀번호를 바꾸면 다른 기기의 로그인이 해제돼요.'));}
  if(action==='username'){value=field(form,'새 ID','text','username');value.required=true;}
  if(action==='delete')form.append(node('p','계정과 로그인 연결만 삭제해요. tmux 세션과 파일은 그대로예요.'));
  const status=node('p','','q-account-status'),submit=node('button',title,'primary');submit.type='submit';form.append(status,submit);
  form.onsubmit=async event=>{event.preventDefault();if(repeat&&value.value!==repeat.value){status.textContent=t('비밀번호가 서로 달라요.');return;}
   const body={action,current_password:current.value,...(action==='password'?{password:value.value}:action==='username'?{username:value.value}:{})};form.querySelectorAll('input[type=password]').forEach(input=>input.value='');submit.disabled=true;
   try{const result=await request(body);if(result.recovery_code)recovery(form,result.recovery_code,()=>d.close());else if(action==='delete')location.reload();else{status.textContent=t('변경했어요.');await refresh();}}
   catch(error){status.textContent=error.message}finally{body.current_password=body.password='';submit.disabled=false;}
  };
 }
 async function devices(){const d=dialog('기기 연결 관리'),status=node('p','','q-account-status'),list=node('div','','q-account-devices'),selected=new Set();d.append(status,list);
  async function render(){try{const value=await request({action:'devices'});list.replaceChildren();selected.clear();const all=node('input');all.type='checkbox';const label=node('label','','q-account-remember');label.append(all,document.createTextNode(t('전체 선택')));list.append(label);
   const actions=node('div','','q-account-actions'),remove=button('선택 해제',()=>revoke({ids:[...selected]})),removeAll=button('모든 앱의 기기 연결 해제',()=>{if(confirm(t('이 기기를 포함한 모든 앱의 연결을 해제할까요?')))revoke({all:true})});remove.disabled=true;
   for(const item of value.devices){const row=node('label','','q-account-device'),check=node('input');check.type='checkbox';check.dataset.accountDevice=item.id;check.onchange=()=>{check.checked?selected.add(item.id):selected.delete(item.id);remove.disabled=!selected.size;};const text=node('span','tmux · '+item.label+(item.current?' · '+t('이 기기'):''));row.append(check,text);list.append(row)}
   all.onchange=()=>{for(const input of list.querySelectorAll('[data-account-device]')){input.checked=all.checked;input.dispatchEvent(new Event('change'));}};actions.append(remove,removeAll);list.append(actions);
  }catch(error){status.textContent=error.message}}
  async function revoke(body){try{const result=await request({action:'revoke',...body});if(result.current)location.reload();else await render()}catch(error){status.textContent=error.message}}
  await render();
 }
 function mountSettings(parent){if(parent.querySelector('.q-account-settings'))return;const section=node('section','','q-account-settings'),title=node('h3','계정'),content=node('div');section.append(title,content);parent.append(section);
  const refresh=async()=>{try{const value=await request();content.replaceChildren();if(!value.user){const open=initial=>{const d=dialog('계정 설정'),legacy=node('form');legacy.style.display='none';d.append(legacy);authBox(legacy,{setup:true,initial})};const actions=node('div','','q-account-actions');actions.append(button('계정 만들기',()=>open('register')),button('기존 계정 연결',()=>open('login')));content.append(node('p','접속키로 연결했어요. ID와 비밀번호를 만들어 다음부터 로그인할 수 있어요.'),actions);return;}
   content.append(node('strong',value.user.username,'q-account-username'));const actions=node('div','','q-account-actions');for(const [action,label]of [['password','비밀번호 변경'],['username','ID 변경'],['recovery','복구 코드 재발급'],['delete','계정 삭제']])actions.append(button(label,()=>manage(action,refresh)));actions.append(button('기기 연결 관리',devices),button('로그아웃',async()=>{await request({action:'logout'});location.reload()}));content.append(actions);
  }catch(error){content.textContent=error.message}};refresh();
 }
 function fitLogin(host,legacy){
  if(host.dataset.setup==='true'||host.closest('dialog')||host.classList.contains('q-login-card'))return;
  if(legacy.id==='appLaunchLogin'&&legacy.hidden){const observer=new MutationObserver(()=>{if(!legacy.hidden){observer.disconnect();fitLogin(host,legacy)}});observer.observe(legacy,{attributes:true,attributeFilter:['hidden']});return;}
  let screen=host.closest('#login-view,.app-login,#appLauncher');
  if(!screen){screen=node('main','','q-login-screen');host.before(screen);screen.append(host);}
  screen.classList.add('q-login-screen');host.classList.add('q-login-card');
  const original=host.querySelector('.login-brand')||screen.querySelector('.identity'),outside=screen.parentElement===document.body?document.body:null;
  const title=original?.querySelector('h1')||screen.querySelector(':scope>h1')||outside?.querySelector(':scope>h1')||node('h1',document.body.dataset.appName||'Q');
  let logo=original?.querySelector('img,.brand-mark')||screen.querySelector(':scope>.app-mark');
  if(!logo||logo.classList.contains('brand-mark')){logo?.remove();logo=node('img');logo.src=document.body.dataset.uiApp==='tmux'?'/static/assets/icon.svg?v=blue-q1':'/app-icon-192.png';logo.alt='';}
  logo.classList.add('q-login-logo');const identity=node('div','','q-login-identity'),heading=node('header','','q-login-heading');identity.append(logo,title);heading.append(identity);original?.remove();host.prepend(heading);
  for(const parent of [screen,outside].filter(Boolean)){
   for(const paragraph of parent.querySelectorAll(':scope>p:not([id])'))paragraph.remove();
   const status=parent.querySelector(':scope>#msg,:scope>#appLaunchStatus');if(status)host.querySelector('.q-key-login').append(status);
   const install=parent.querySelector(':scope>button[data-app-install]');if(install){install.classList.add('q-login-install');host.append(install);}
  }
  const languageObserver=new MutationObserver(moveLanguage);
  function moveLanguage(){const language=legacy.querySelector('.q-language-choice');if(language){heading.append(language);languageObserver.disconnect();}}
  languageObserver.observe(legacy,{childList:true,subtree:true});moveLanguage();
  const show=()=>{document.body.classList.toggle('q-login-page',!screen.hidden);if(screen.hidden)document.body.classList.remove('q-login-keyboard')};show();new MutationObserver(show).observe(screen,{attributes:true,attributeFilter:['hidden']});
  const keyboard=()=>{if(!document.body.classList.contains('q-login-page'))return;const small=!!window.visualViewport&&window.visualViewport.height<innerHeight*.78;document.body.classList.toggle('q-login-keyboard',small);if(small&&host.contains(document.activeElement))document.activeElement.scrollIntoView({block:'nearest'});};window.visualViewport?.addEventListener('resize',keyboard);
 }
 function fitLauncher(){
  const screen=document.querySelector('#app-launcher,#appLauncher');if(!screen)return;screen.classList.add('q-login-screen','q-launch-compact');document.body.classList.add('q-login-page');
  if(!screen.querySelector('.identity')){const logo=screen.querySelector(':scope>.app-mark'),title=screen.querySelector(':scope>h1');if(logo&&title){const identity=node('div','','identity');identity.append(logo,title);screen.prepend(identity);}}
 }
 const loginScreenStyles=`
 body.q-login-page{--ql-bg:#111316;--ql-field:#1b1f24;--ql-ink:#e9edf2;--ql-muted:#a0aab7;--ql-line:#343c46;--ql-accent:#9cbcdc;--ql-action-ink:#142b41;--ql-focus:#b3cde7;box-sizing:border-box;display:flex!important;flex-direction:column;justify-content:center;align-items:center;gap:18px;min-height:100svh;height:auto;max-width:none!important;margin:0!important;padding:clamp(20px,5svh,44px) max(20px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left))!important;background:var(--ql-bg)!important;color:var(--ql-ink)!important;overflow-y:auto;overflow-x:hidden;font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color-scheme:dark}
 @media(prefers-color-scheme:light){body.q-login-page{--ql-bg:#eff3f7;--ql-field:#fff;--ql-ink:#203144;--ql-muted:#5b6d7f;--ql-line:#ccd6e0;--ql-accent:#497aa6;--ql-action-ink:#fff;--ql-focus:#497aa6;color-scheme:light}:root[data-theme=dark] body.q-login-page{--ql-bg:#111316;--ql-field:#1b1f24;--ql-ink:#e9edf2;--ql-muted:#a0aab7;--ql-line:#343c46;--ql-accent:#9cbcdc;--ql-action-ink:#142b41;--ql-focus:#b3cde7;color-scheme:dark}}
 :root[data-theme=light] body.q-login-page{--ql-bg:#eff3f7;--ql-field:#fff;--ql-ink:#203144;--ql-muted:#5b6d7f;--ql-line:#ccd6e0;--ql-accent:#497aa6;--ql-action-ink:#fff;--ql-focus:#497aa6;color-scheme:light}
 .q-login-page .q-login-screen{display:block;box-sizing:border-box;width:min(100%,352px);min-height:0;height:auto;max-width:none;margin:0;padding:0;background:transparent;text-align:left;overflow:visible}
 .q-login-page .q-login-card.q-account-login{display:grid;grid-template-columns:minmax(0,1fr);box-sizing:border-box;width:100%;max-width:none;margin:0;padding:0;background:transparent;border:0;box-shadow:none;min-width:0;font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--ql-ink)}
 .q-login-page .q-login-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;position:static;height:auto;margin:0 0 22px;padding:0;border:0;background:transparent;min-width:0}
 .q-login-page .q-login-identity{display:flex;align-items:center;gap:9px;min-width:0}
 .q-login-page .q-login-identity .q-login-logo{display:block;flex:none;width:36px;height:36px;margin:0;border-radius:9px;object-fit:contain}
 .q-login-page .q-login-heading h1{font:650 clamp(20px,5.3vw,24px)/1.2 system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:-.65px;margin:0;color:var(--ql-ink);white-space:nowrap}
 .q-login-page .q-login-heading .q-language-choice{display:flex!important;flex:none;gap:0;margin:0!important;align-items:center}
 .q-login-page .q-login-heading .q-language-choice>span{display:none}
 .q-login-page .q-login-heading .q-language-choice select{width:78px!important;min-width:0!important;height:29px!important;min-height:29px!important;padding:3px 5px!important;font:11px/1.4 system-ui!important;background:transparent;color:var(--ql-muted);border:1px solid var(--ql-line);border-radius:6px}
 .q-login-page .q-login-card .q-key-login,.q-login-page .q-login-card .q-account-section{min-width:0;font:12px/1.5 system-ui}
 .q-login-page .q-login-card .q-key-login>h2,.q-login-page .q-login-card .q-account-section>h2{font:600 12px/1.4 system-ui;margin:0 0 6px;color:var(--ql-ink)}
 .q-login-page .q-login-card .q-key-login>p:not([id]){font:11px/1.5 system-ui;margin:0 0 10px;color:var(--ql-muted);opacity:1}
 .q-login-page .q-login-card .q-key-login>form{display:grid;gap:6px;padding:0!important;margin:0!important;width:100%;color:var(--ql-ink)}
 .q-login-page .q-login-card label:not(.q-language-choice){font:11px/1.4 system-ui!important;color:var(--ql-muted);margin:0;gap:4px}
 .q-login-page .q-login-card .q-key-login>form>label:not(.device-remember-choice){display:block;margin:0}
 .q-login-page .q-login-card input:not([type=checkbox]){box-sizing:border-box;width:100%;min-width:0;height:40px;min-height:40px;margin:0;padding:7px 10px;font:16px/1.4 system-ui!important;background:var(--ql-field)!important;color:var(--ql-ink)!important;border:1px solid var(--ql-line);border-color:var(--ql-line)!important;border-radius:7px;box-shadow:none;scroll-margin-block:12px;outline:none}
 .q-login-page .q-login-card input:not([type=checkbox]):focus{border-color:var(--ql-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--ql-accent) 18%,transparent)}
 .q-login-page .q-login-card input::placeholder{color:var(--ql-muted);opacity:.7}
 .q-login-page .q-login-card .device-remember-choice,.q-login-page .q-login-card .q-account-remember{display:flex!important;align-items:center!important;gap:6px!important;margin:2px 0!important;font:11px/1.4 system-ui!important;color:var(--ql-muted)}
 .q-login-page .q-login-card .device-remember-choice small{display:none}
 .q-login-page .q-login-card input[type=checkbox]{appearance:auto;width:13px!important;height:13px!important;min-height:0!important;margin:0!important;padding:0;accent-color:var(--ql-accent)}
 .q-login-page .q-login-card .q-key-login>form>button:not([data-install]),.q-login-page .q-login-card .q-account-form>button{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:36px!important;min-height:36px!important;margin:3px 0 0!important;padding:6px 10px!important;border:1px solid transparent;border-radius:7px;background:var(--ql-accent);color:var(--ql-action-ink);font:600 13px/1.4 system-ui!important;cursor:pointer;box-shadow:none}
 .q-login-page .q-login-card .login-submit svg{width:15px;height:15px}
 .q-login-page .q-login-card .q-account-section{display:grid;grid-template-columns:minmax(0,1fr) auto;align-content:start;align-items:baseline;column-gap:8px;margin:18px 0 0;padding:15px 0 0;border-top:1px solid var(--ql-line)}
 .q-login-page .q-login-card .q-account-section>div:not(.q-account-tabs),.q-login-page .q-login-card .q-account-status{grid-column:1/-1}
 .q-login-page .q-login-card .q-account-tabs{display:flex;gap:7px;margin:0 0 9px;justify-content:flex-end}
 .q-login-page .q-login-card .q-account-tabs button{width:auto;min-height:22px;margin:0;padding:0!important;border:0!important;border-radius:0;background:transparent!important;color:var(--ql-muted)!important;font:11px/1.4 system-ui!important;text-decoration:underline;text-underline-offset:3px}
 .q-login-page .q-login-card .q-account-tabs button[aria-pressed=true]{display:none}
 .q-login-page .q-login-card .q-account-form{gap:8px;margin:0}
 .q-login-page .q-login-card .q-account-form label{gap:4px}
 .q-login-page .q-login-card .q-account-status,.q-login-page .q-login-card #msg,.q-login-page .q-login-card #login-error,.q-login-page .q-login-card #appLaunchStatus{font:11px/1.5 system-ui;color:var(--ql-muted);min-height:0;margin:7px 0 0;overflow-wrap:anywhere}
 .q-login-page .q-login-card .q-account-status:empty,.q-login-page .q-login-card #msg:empty,.q-login-page .q-login-card #login-error:empty{display:none}
 .q-login-page .q-login-card :focus-visible{outline:2px solid var(--ql-focus);outline-offset:2px}
 .q-login-page .q-login-card button:hover{filter:brightness(1.05)}
 .q-login-page .q-login-install{grid-column:1/-1;justify-self:end;width:auto;padding:4px 0;min-height:25px;margin-top:10px;border:0;background:transparent;color:var(--ql-muted);font:11px system-ui}
 .q-login-page .login-credit,.q-login-page .app-credit,.q-login-page>footer{position:static!important;align-self:center;flex:none;margin:0;padding:0;font:10px/1.4 system-ui!important;color:var(--ql-muted)!important;opacity:.75}
 .q-login-page .q-login-screen>.login-credit{display:block;margin:16px 0 0!important;text-align:center}
 .q-login-page .q-launch-compact>.identity{display:flex;align-items:center;gap:10px;margin-bottom:18px}
 .q-login-page .q-launch-compact>.identity img,.q-login-page .q-launch-compact>.identity .app-mark{width:38px;height:38px;margin:0;border-radius:9px;font:700 32px/38px system-ui;color:var(--ql-accent)}
 .q-login-page .q-launch-compact>.identity h1{font:650 23px/1.2 system-ui;letter-spacing:-.6px;margin:0;color:var(--ql-ink)}
 .q-login-page .q-launch-compact>.app-intro,.q-login-page .q-launch-compact>.app-description,.q-login-page .q-launch-compact>.launch-hint,.q-login-page .q-launch-compact>small{display:none}
 .q-login-page .q-launch-compact>.launch-connection{padding:9px 0;margin:0 0 9px;border-color:var(--ql-line)}
 .q-login-page .q-launch-compact #launch-status{font:12px/1.5 system-ui;color:var(--ql-muted);min-height:2.6em;margin:0 0 12px}
 .q-login-page .q-launch-compact .actions,.q-login-page .q-launch-compact .launch-actions{display:flex;align-items:center;gap:6px;margin-top:8px}
 .q-login-page .q-launch-compact>button,.q-login-page .q-launch-compact .actions>button,.q-login-page .q-launch-compact .launch-actions>button{width:auto;min-height:34px;padding:6px 11px;border:1px solid var(--ql-line);border-radius:7px;background:var(--ql-field);color:var(--ql-ink);font:12px/1.4 system-ui}
 @media(min-width:700px){.q-login-page .q-login-screen{width:min(100%,660px)}.q-login-page .q-login-card.q-account-login{grid-template-columns:minmax(0,1fr) minmax(0,1fr);column-gap:26px}.q-login-page .q-login-heading{grid-column:1/-1;margin-bottom:25px}.q-login-page .q-login-card .q-account-section{margin:0;padding:0 0 0 26px;border-top:0;border-left:1px solid var(--ql-line)}.q-login-page .q-login-heading h1{font-size:24px}}
 @media(max-height:600px){body.q-login-page{justify-content:flex-start;padding-top:16px!important;padding-bottom:16px!important;gap:12px}.q-login-page .q-login-heading{margin-bottom:15px}.q-login-page .q-login-card .q-account-section{margin-top:13px;padding-top:12px}.q-login-page .q-login-identity .q-login-logo{width:30px;height:30px}.q-login-page .q-login-heading h1{font-size:20px}}
 @media(min-width:700px) and (max-height:600px){.q-login-page .q-login-card .q-account-section{margin:0;padding-top:0}}
 body.q-login-page.q-login-keyboard{justify-content:flex-start;padding-top:12px!important}
 `;
 function boot(){const style=node('style');style.textContent='.q-account-form{display:grid;gap:7px;margin:0}.q-account-form label{display:grid;gap:3px;font-size:11px}.q-account-form input:not([type=checkbox]){box-sizing:border-box;width:100%;min-width:0;min-height:34px;margin:0;padding:5px 8px;font:14px/1.4 system-ui;border:1px solid var(--q-line,#454b54);border-radius:6px;background:var(--q-input,#171b21);color:var(--q-ink,#e3e8ef)}.q-account-form button,.q-account-tabs button,.q-account-actions button,.q-account-dialog button{width:auto;min-height:28px;margin:0;padding:4px 8px;border:1px solid var(--q-line,#454b54);border-radius:6px;background:var(--q-raised,#252c35);color:var(--q-ink,#e3e8ef);font:11px/1.4 system-ui;cursor:pointer}.q-account-form button.primary,.q-account-dialog button.primary{background:#9bb9db;color:#142438;border-color:#9bb9db}.q-account-form small,.q-account-settings p{font-size:10px;line-height:1.5;opacity:.75}.q-account-tabs{display:flex;gap:4px;margin:8px 0}.q-account-tabs button[aria-pressed=true]{background:#9bb9db;color:#142438;border-color:#9bb9db}.q-account-remember{display:flex!important;align-items:center;gap:6px;font-size:11px!important;margin:2px 0}.q-account-remember input,.q-account-device input{width:13px!important;height:13px!important;min-height:0!important;margin:0!important;flex:none}.q-account-status{font:11px/1.5 system-ui;overflow-wrap:anywhere}.q-account-status:empty{display:none}.q-key-login{font-size:11px}.q-account-section{margin-top:16px;padding-top:12px;border-top:1px solid var(--q-line,#454b54)}.q-account-login[data-setup=true] .q-account-section{margin:0;padding:0;border:0}.q-account-login[data-setup=true] .q-account-section>h2{display:none}.q-account-section h2,.q-key-login h2{margin:0 0 7px;font:600 12px/1.4 system-ui}.q-key-login>p{font:11px/1.5 system-ui;opacity:.75;margin:0 0 7px}.q-key-login>form{padding:8px 0 0!important;margin:0!important;box-shadow:none!important;border:0!important;border-radius:0!important;max-width:none!important;background:transparent!important}.q-key-login .login-brand,.q-key-login .install-link{display:none}.q-account-dialog{width:min(390px,calc(100vw - 20px));box-sizing:border-box;max-height:85dvh;overflow:auto;padding:13px;border:1px solid var(--q-line,#454b54);border-radius:10px;background:var(--q-surface,#171b21);color:var(--q-ink,#e3e8ef);font:13px/1.5 system-ui}.q-account-dialog::backdrop{background:#0008}.q-account-dialog>header{display:flex;align-items:center;justify-content:space-between;position:static;background:transparent;padding:0;margin:0 0 12px;height:auto}.q-account-dialog h2{font-size:15px;margin:0}.q-account-settings{border-top:1px solid var(--q-line,#454b54);margin-top:16px;padding-top:10px}.q-account-settings h3{font-size:13px;margin:0 0 7px}.q-account-actions{display:flex;gap:5px;flex-wrap:wrap;margin-top:9px}.q-recovery-code{display:block;padding:10px;margin:8px 0;border:1px solid var(--q-line,#454b54);border-radius:6px;overflow-wrap:anywhere;user-select:all;font:13px/1.5 monospace}.q-account-device{display:flex;gap:7px;align-items:center;font-size:11px;margin:9px 0}.q-account-login .login-brand{margin-bottom:10px}.q-account-login.login-card{width:min(100%,340px);padding:18px}.q-account-connect{margin:2px 0}.q-account-username{font-size:12px}@media(max-width:600px){.q-account-form input:not([type=checkbox]){font-size:16px}.q-account-login.login-card{padding:14px}}';document.head.append(style);
  style.textContent+='.q-account-login .q-key-login>form>button:not([data-install]),.q-account-login .q-account-form>button{min-height:32px!important;height:auto!important;padding:5px 10px!important;margin-top:5px!important;font:600 14px/1.35 system-ui!important;border-radius:7px}.q-account-login .q-account-tabs button{min-height:28px;padding:4px 8px;font:12px/1.35 system-ui}';
  style.textContent+=loginScreenStyles;
  fitLauncher();
  for(const form of document.querySelectorAll('#login-form,.app-login form,#appLaunchLogin,body>form'))if(form.querySelector('input[type=password],#access-key')){authBox(form);const host=form.closest('.q-account-login');if(host)requestAnimationFrame(()=>fitLogin(host,form));}
 }
 window.QAccounts={mountSettings};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
