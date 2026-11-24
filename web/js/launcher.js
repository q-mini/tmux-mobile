const qLangLauncher=globalThis.QI18n||{t:value=>value,html:value=>value,f:(key,values)=>key.replace(/\{(\d+)\}/g,(_,index)=>String(values[index]??'')),locale:'ko-KR'};
(function(){
 'use strict';
 const config=document.querySelector('[data-app-name]'),name=config?.dataset.appName||qLangLauncher.t('앱'),standalone=()=>matchMedia('(display-mode: standalone)').matches||!!navigator.standalone;
 let prompt=null,timer,delay=1000,busy=false;
 const setup=document.getElementById('app-launcher'),status=document.getElementById('launch-status');
 const ios=/iPhone|iPad|iPod/.test(navigator.userAgent)||navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1;
 const mac=!ios&&/Mac|macOS/.test(navigator.platform+' '+navigator.userAgent);
 function help(){return ios?qLangLauncher.t('Safari에서 공유 → 홈 화면에 추가 → 추가를 누르세요. 웹 앱으로 열기가 있으면 켜 두세요.'):mac?qLangLauncher.t('Safari: 상단 파일 → Dock에 추가(macOS 14 이상).\nChrome: ⋮ → 전송, 저장 및 공유 → 페이지를 앱으로 설치.'):qLangLauncher.t('Chrome·Edge에서 주소창의 설치 아이콘 또는 메뉴 → 앱 설치를 선택하세요. Android는 메뉴 → 홈 화면에 추가 → 설치를 사용할 수 있어요.');}
 function install(){
  let dialog=document.getElementById('install-dialog');
  if(!dialog){dialog=document.createElement('dialog');dialog.id='install-dialog';dialog.innerHTML=qLangLauncher.html('<h2></h2><p class="install-help"></p><p>설치한 아이콘을 누르면 서버에 다시 연결해요.</p><div class="install-actions"><button type="button" data-install-close>닫기</button><button type="button" data-native-install hidden>설치</button></div>');document.body.append(dialog);dialog.querySelector('[data-install-close]').onclick=()=>dialog.close();}
  dialog.querySelector('h2').textContent=name+qLangLauncher.t(' 앱 설치');
  dialog.querySelector('.install-help').textContent=help();
  const button=dialog.querySelector('[data-native-install]');button.hidden=!prompt||standalone();
  button.onclick=async()=>{const current=prompt;if(!current)return;prompt=null;dialog.close();await current.prompt();await current.userChoice;};
  if(!dialog.open)dialog.showModal();
 }
 addEventListener('beforeinstallprompt',event=>{event.preventDefault();prompt=event;if(document.getElementById('install-dialog')?.open)install();});
 addEventListener('appinstalled',()=>{prompt=null;document.getElementById('install-dialog')?.close();});
 document.querySelectorAll('[data-install]').forEach(button=>{button.hidden=standalone();button.onclick=install;});
 async function connect(){
  clearTimeout(timer);if(busy||!setup)return;busy=true;
  status.textContent='Loading…';
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),6000);
  try{const response=await fetch('/api/session',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
   if(response.status===401){location.replace('/');return;}
   if(!response.ok)throw Error('unavailable');location.replace('/');
  }catch{status.textContent='Loading…';timer=setTimeout(connect,delay);delay=Math.min(delay*1.6,15000);}
  finally{clearTimeout(timeout);busy=false;}
 }
 window.AppLauncher={install,connect};
 if(!setup)return;
 const force=new URLSearchParams(location.search).get('launch')==='1';
 document.getElementById('launch-open').onclick=()=>location.assign('/');
 if(standalone()||force||location.pathname!=='/app'){document.getElementById('launch-open').textContent=qLangLauncher.t('다시 연결');document.getElementById('launch-open').onclick=connect;connect();addEventListener('online',connect);document.addEventListener('visibilitychange',()=>{if(!document.hidden)connect();});}
 else{setup.classList.remove('connection-only');status.textContent=qLangLauncher.t('앱을 설치하면 Dock·홈 화면 아이콘으로 열 수 있어요.');install();}
})();
