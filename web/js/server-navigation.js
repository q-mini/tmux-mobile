const qLangServerNavigation=globalThis.QI18n||{t:value=>value,html:value=>value,f:(key,values)=>key.replace(/\{(\d+)\}/g,(_,index)=>String(values[index]??'')),locale:'ko-KR'};
'use strict';
// Shared by the compact reader, fullscreen terminal and split workspace.
const ServerNavigation={
  folded(){try{return JSON.parse(localStorage.getItem('tmux-server-folds'))||{};}catch{return {}; }},
  tone(id){if(!id||id==='local')return 'blue';let hash=0;for(const c of id)hash=(hash*31+c.charCodeAt(0))>>>0;return ['blue','violet','sage','amber','rose','cyan'][hash%6];},
  color(id){return 'var(--q-server-'+this.tone(id)+')';},
  paint(node,id){node.dataset.serverTone=this.tone(id);node.style.setProperty('--server-color',this.color(id));},
  group(host,changed,connect,manage){
    const section=document.createElement('section');section.className='server-session-group';this.paint(section,host.id);section.dataset.host=host.id;
    const row=document.createElement('div');row.className='server-group-heading';
    const toggle=document.createElement('button');toggle.type='button';toggle.className='server-group-toggle';
    const collapsed=this.folded()[host.id]===true;toggle.setAttribute('aria-expanded',String(!collapsed));
    const chevron=document.createElement('span');chevron.className='server-chevron';chevron.setAttribute('aria-hidden','true');chevron.innerHTML='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6 4 4 4-4"/></svg>';
    const name=document.createElement('strong');name.textContent=host.name;toggle.append(chevron,name);toggle.title=host.name+' · '+(qLangServerNavigation.t(host.status||'연결됨'));
    const items=document.createElement('div');items.className='server-group-items';items.hidden=collapsed;
    toggle.addEventListener('click',()=>{const folds=this.folded();folds[host.id]=!items.hidden;localStorage.setItem('tmux-server-folds',JSON.stringify(folds));changed();});
    const more=document.createElement('button');more.type='button';more.textContent='⋯';more.className='navigation-more';more.setAttribute('aria-label',host.name+qLangServerNavigation.t(' 서버 관리'));more.addEventListener('click',()=>window.NavigationFolders?NavigationFolders.serverMenu(more,host,()=>manage(host)):manage(host));row.append(toggle,more);section.append(row);
    if(!host.connected){const status=document.createElement('button');status.type='button';status.className='server-connect';status.textContent=qLangServerNavigation.t(host.status||'연결 설정');status.addEventListener('click',()=>connect(host));section.append(status);}
    section.append(items);window.NavigationFolders?.decorate(section,host);return {section,items};
  },
  row(session,button,manage){const row=document.createElement('div');row.className='navigation-session';row.dataset.session=session.id;row.append(button);const more=document.createElement('button');more.type='button';more.className='navigation-more';more.textContent='⋯';more.setAttribute('aria-label',session.name+qLangServerNavigation.t(' 세션 메뉴'));more.addEventListener('click',event=>{event.stopPropagation();if(window.NavigationFolders)NavigationFolders.sessionMenu(more,session,()=>manage(session));else manage(session);});row.append(more);return row;},
  add(callback){const button=document.createElement('button');button.type='button';button.className='server-add';button.textContent=qLangServerNavigation.t('＋ 서버');button.addEventListener('click',callback);return button;}
};
window.addEventListener('storage',event=>{if(event.key==='tmux-server-folds')window.dispatchEvent(new Event('server-navigation-change'));});
