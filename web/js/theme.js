const qLangTheme=globalThis.QI18n||{t:value=>value,html:value=>value,f:(key,values)=>key.replace(/\{(\d+)\}/g,(_,index)=>String(values[index]??'')),locale:'ko-KR'};
/* Theme preference belongs to this browser; same-origin panels follow it live. */
(function(){
  'use strict';
  const key='q-ui-theme',choices=['dark','light'];
  let mode='dark',button;const buttons=[];
  function read(){try{const saved=localStorage.getItem(key);return choices.includes(saved)?saved:'dark';}catch{return 'dark';}}
  function apply(){
    const theme=mode;
    document.documentElement.dataset.theme=theme;document.documentElement.dataset.themeMode=mode;
    document.documentElement.style.colorScheme=theme;
    for(const sheet of document.querySelectorAll('link[data-app-theme="light"]'))sheet.media=theme==='light'?'all':'not all';
    const meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.content=theme==='light'?'#dedede':'#080808';
    const scheme=document.querySelector('meta[name="color-scheme"]');if(scheme)scheme.content=theme;
    // An opaque status bar keeps system indicators legible on installed iOS apps.
    const status=document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');if(status)status.content=theme==='dark'?'black':'default';
    for(const button of buttons){const label={auto:qLangTheme.t('자동'),light:qLangTheme.t('밝게'),dark:qLangTheme.t('어둡게')}[mode];button.querySelector('span').textContent=label;button.title=qLangTheme.t('화면 테마: ')+label+qLangTheme.t(' · 눌러서 변경');button.setAttribute('aria-label',button.title);}
    window.dispatchEvent(new CustomEvent('app-theme-change',{detail:{mode,theme}}));
  }
  function set(value){if(!choices.includes(value))return;mode=value;try{localStorage.setItem(key,mode);}catch{}apply();}
  window.AppTheme={set,get mode(){return mode;},get theme(){return document.documentElement.dataset.theme;}};
  mode=read();apply();
  window.addEventListener('storage',event=>{if(event.key===key||event.key===null){mode=read();apply();}});
  window.addEventListener('q-language-change',apply);
  function boot(){
    apply();if(new URLSearchParams(location.search).get('panel')==='1')return;
    const style=document.createElement('style');style.textContent='.app-theme-button{display:inline-flex;align-items:center;justify-content:center;gap:5px;flex:none;font:11px/1.4 system-ui!important;min-height:30px;padding:5px 7px!important;white-space:nowrap}.app-theme-button svg{width:15px;height:15px;flex:none}.app-theme-floating{width:auto!important;position:fixed;top:max(12px,env(safe-area-inset-top));right:max(12px,env(safe-area-inset-right));z-index:60;background:#223044;color:#e3e7ed;border:1px solid #506477;border-radius:6px}:root[data-theme=light] .app-theme-floating{background:#f0ebd8;color:#565247;border-color:#cfc5a9}@media(max-width:480px){.app-header .app-theme-button{gap:3px;padding:4px!important;font-size:10px!important}}';document.head.append(style);
    button=document.createElement('button');button.type='button';button.className='app-theme-button';button.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none"/></svg><span></span>';
    button.addEventListener('click',()=>set(choices[(choices.indexOf(mode)+1)%choices.length]));
    buttons.push(button);
    const host=document.querySelector('.app-header')||document.querySelector('body>header');
    if(host){button.classList.add('quiet');const anchor=host.querySelector('#logout')||host.querySelector('.grow');if(anchor)anchor.before(button);else host.append(button);}
    else{button.classList.add('app-theme-floating');document.body.append(button);}
    const login=document.getElementById('login-view');if(login){const control=button.cloneNode(true);control.classList.remove('quiet');control.classList.add('app-theme-floating');control.addEventListener('click',()=>set(choices[(choices.indexOf(mode)+1)%choices.length]));login.append(control);buttons.push(control);}apply();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
