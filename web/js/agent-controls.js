const qLangAgentControls=globalThis.QI18n||{t:value=>value,html:value=>value,f:(key,values)=>key.replace(/\{(\d+)\}/g,(_,index)=>String(values[index]??'')),locale:'ko-KR'};
/* Complete from the selected host's native command menu and installed skills. */
(function(root){
 'use strict';
 const node=(tag,text='',className='')=>{const el=document.createElement(tag);el.textContent=text;el.className=className;return el};
 class AgentControls{
  constructor({form,input,fetch,send,notice,changed}){
   Object.assign(this,{form,input,fetch,send,notice,changed});this.target='';this.generation=0;this.items=[];this.matches=[];this.index=0;this.composing=false;
   this.popup=node('div','','agent-completions');this.popup.hidden=true;
   this.caption=node('div','','agent-completion-caption');this.list=node('div','','agent-completion-list');this.list.id='agent-completions';this.list.setAttribute('role','listbox');this.list.setAttribute('aria-label',qLangAgentControls.t('명령과 스킬'));
   const help=node('div','','agent-completion-help');help.innerHTML=qLangAgentControls.html('<span class="completion-keyboard"><kbd>↑</kbd><kbd>↓</kbd> 이동 <kbd>↵</kbd> 선택 <kbd>esc</kbd> 닫기</span><span class="completion-touch">탭하여 선택</span>');
   this.popup.append(this.caption,this.list,help);document.body.append(this.popup);
   this.reposition=()=>{if(!this.popup.hidden)this.position()};
   addEventListener('resize',this.reposition);window.visualViewport?.addEventListener('resize',this.reposition);window.visualViewport?.addEventListener('scroll',this.reposition);
   document.addEventListener('scroll',event=>{if(!this.popup.contains(event.target))this.reposition()},true);
   new ResizeObserver(this.reposition).observe(form);
   input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-controls',this.list.id);input.setAttribute('aria-expanded','false');
   this.model=node('button',qLangAgentControls.t('모델'),'quiet agent-model-button');this.model.type='button';this.model.disabled=true;this.model.onclick=()=>this.openModel();
   const actions=form.querySelector('.compose-actions');actions.insertBefore(this.model,actions.querySelector('.attachment-button')?.nextSibling||actions.firstChild);
   this.sessionBar=node('div','','agent-session-state');this.sessionBar.hidden=true;this.account=node('span');this.login=node('button',qLangAgentControls.t('Claude 로그인'),'quiet');this.login.type='button';this.login.onclick=()=>this.openLogin();this.modeButton=node('button',qLangAgentControls.t('모드 변경'),'quiet');this.modeButton.type='button';this.modeButton.onclick=()=>this.changeMode();this.sessionBar.append(this.account,this.login,this.modeButton);actions.before(this.sessionBar);
   input.addEventListener('input',()=>{this.update();if(this.token())this.refresh()});input.addEventListener('click',()=>this.update());input.addEventListener('focus',()=>{this.update();this.refresh()});
   input.addEventListener('compositionstart',()=>{this.composing=true;this.hide()});input.addEventListener('compositionend',()=>{this.composing=false;this.update()});
   input.addEventListener('keydown',event=>{
    if(this.popup.hidden||event.isComposing||this.composing||event.keyCode===229)return;
    if(!this.matches.length&&['ArrowDown','ArrowUp','Enter','Tab'].includes(event.key)){if(!event.shiftKey){event.preventDefault();event.stopImmediatePropagation();}return;}
    if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();this.index=(this.index+(event.key==='ArrowDown'?1:-1)+this.matches.length)%this.matches.length;this.highlight();}
    else if((event.key==='Enter'&&!event.shiftKey)||event.key==='Tab'){event.preventDefault();event.stopImmediatePropagation();this.apply(this.matches[this.index]);}
    else if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();this.hide()}
   },true);
   document.addEventListener('pointerdown',event=>{if(event.target!==input&&!this.popup.contains(event.target))this.hide()});
  }
  select(target){
   if(target===this.target){this.refresh();return;}this.closeModel(false);this.closeLogin();clearTimeout(this.stateTimer);this.authKnown='unknown';this.target=target;this.generation++;this.items=[];this.agent=null;this.lastError='';delete this.form.dataset.agent;this.loaded=0;this.loading=null;this.model.disabled=true;this.sessionBar.hidden=true;this.hide();
   this.refresh();if(target)this.pollState();
  }
  async pollState(){
   clearTimeout(this.stateTimer);const target=this.target,generation=this.generation;if(!target)return;
   try{if(!document.hidden){const state=await this.fetch('/api/panes/'+encodeURIComponent(target)+'/agent-state');if(generation!==this.generation)return;this.state=state;this.sessionBar.hidden=state.agent!=='Claude';
    if(state.auth&&state.auth!=='unknown')this.authKnown=state.auth;
    this.account.textContent=this.authKnown==='signed_out'?qLangAgentControls.t('Claude · 로그인 필요'):this.authKnown==='signed_in'?qLangAgentControls.t('Claude · 로그인됨'):'Claude CLI';this.account.dataset.auth=this.authKnown||'';
    this.modeButton.textContent=qLangAgentControls.t(({auto:'자동 모드',plan:'계획 모드','accept-edits':'편집 허용',bypass:'권한 확인 생략',default:'기본 모드'})[state.mode]||'모드 변경');this.modeButton.setAttribute('aria-pressed',String(state.mode==='auto'));this.modeButton.title='Shift+Tab';this.modeButton.disabled=!state.ready;this.login.disabled=!state.ready&&!state.login_screen;
    if(this.loginDialog?.open){this.loginScreen.textContent=state.login_screen||qLangAgentControls.t(this.authKnown==='signed_in'?'로그인했어요. 이 창을 닫고 계속하세요.':'로그인 화면을 기다리는 중…');this.loginLinks.replaceChildren();for(const url of state.login_links||[]){const a=node('a',qLangAgentControls.t('브라우저에서 로그인'));a.href=url;a.target='_blank';a.rel='noopener noreferrer';this.loginLinks.append(a)}for(const button of this.loginDialog.querySelectorAll('[data-auth-key],.agent-login-code button'))button.disabled=!state.login_screen;}
   }}catch{}finally{if(generation===this.generation)this.stateTimer=setTimeout(()=>this.pollState(),this.loginDialog?.open?700:4000)}
  }
  async agentAction(command,extra={}){const target=this.target,generation=this.generation;if(!target)return false;try{const state=await this.fetch('/api/panes/'+encodeURIComponent(target)+'/agent-state');if(generation!==this.generation)return false;await this.send({type:'agent_command',command,token:state.command_token,...extra,request_id:crypto.randomUUID()},target);await new Promise(resolve=>setTimeout(resolve,130));await this.pollState();return true;}catch(error){this.notice(error.message);return false;}}
  async changeMode(){this.modeButton.disabled=true;try{await this.agentAction('mode')}finally{this.modeButton.disabled=!this.state?.ready}}
  async openLogin(){
   if(!this.state?.login_screen&&!await this.agentAction('login'))return;
   if(!this.loginDialog){this.loginDialog=node('dialog','','agent-model-dialog agent-login-dialog');const head=node('header'),title=node('strong',qLangAgentControls.t('Claude 로그인')),close=node('button',qLangAgentControls.t('닫기'));close.type='button';close.onclick=()=>this.closeLogin();head.append(title,close);this.loginScreen=node('pre','','agent-login-screen');this.loginLinks=node('div','','agent-login-links');
    const keys=node('div','','agent-login-keys');for(const [label,key]of [['↑','up'],['↓','down'],[qLangAgentControls.t('선택'),'enter'],[qLangAgentControls.t('취소'),'escape']]){const b=node('button',label,'quiet');b.type='button';b.dataset.authKey=key;b.onclick=()=>this.agentAction('login-key',{key});keys.append(b)}
    const form=node('form','','agent-login-code'),code=node('input'),send=node('button',qLangAgentControls.t('코드 확인'));code.type='password';code.autocomplete='off';code.placeholder=qLangAgentControls.t('로그인 코드');code.setAttribute('aria-label',qLangAgentControls.t('로그인 코드'));send.type='submit';form.append(code,send);form.onsubmit=async e=>{e.preventDefault();const value=code.value;code.value='';if(value.trim())await this.agentAction('login-code',{text:value.trim()})};this.loginDialog.append(head,this.loginLinks,this.loginScreen,keys,form);this.loginDialog.addEventListener('close',()=>{code.value='';this.loginScreen.textContent='';this.loginLinks.replaceChildren()});document.body.append(this.loginDialog);
   }if(!this.loginDialog.open)this.loginDialog.showModal();await this.pollState();
  }
  closeLogin(){if(this.loginDialog?.open)this.loginDialog.close();}
  async refresh(){
   if(!this.target||this.loading||Date.now()-this.loaded<5000)return;
   const generation=this.generation,target=this.target;
   const request=this.fetch('/api/panes/'+encodeURIComponent(target)+'/catalog');this.loading=request;this.update();
   try{const data=await request;if(generation!==this.generation)return;this.items=data.items||[];this.agent=data.agent;this.lastError='';this.form.dataset.agent=(data.agent||'').toLowerCase();this.loaded=Date.now();this.model.disabled=!data.agent;this.model.title=data.agent?data.agent+qLangAgentControls.t(' 모델 선택'):qLangAgentControls.t('Codex·Claude 화면에서 사용할 수 있어요.');this.update();}
   catch(error){if(generation===this.generation){this.lastError=error.message;this.popup.title=error.message;}}
   finally{if(this.loading===request){this.loading=null;this.update();}}
  }
  token(){
   if(this.input.selectionStart!==this.input.selectionEnd)return null;
   const end=this.input.selectionStart,match=this.input.value.slice(0,end).match(/(?:^|\s)([/\$])([^\s/\$]*)$/);
   if(!match)return null;
   if(match[1]==='$'&&(this.agent||this.state?.agent)!=='Codex')return null;
   const start=end-match[2].length-1;
   // Native slash commands belong at the start of the prompt. Skills may be
   // mentioned in the body with Codex's $ prefix.
   if(match[1]==='/'&&this.input.value.slice(0,start).trim())return null;
   return {start,end,prefix:match[1],query:match[2].toLowerCase()};
  }
  update(){
   const token=this.token();if(this.composing||document.activeElement!==this.input||!token){this.hide();return;}
   const previous=this.matches[this.index]?.insert,sameQuery=this.lastQuery===token.prefix+token.query;
   this.matches=this.items.filter(item=>(token.prefix==='$'?item.kind==='skill':item.insert.startsWith('/'))&&(item.name.toLowerCase().includes(token.query)||(token.query&&(item.description||'').toLowerCase().includes(token.query))));
   if(!this.matches.length){
    this.caption.textContent=token.prefix==='$'?qLangAgentControls.t('스킬'):qLangAgentControls.t('명령');
    const text=this.loading?qLangAgentControls.t('불러오는 중…'):this.lastError||qLangAgentControls.t(this.agent?'일치하는 명령이나 스킬이 없어요.':'연결된 Codex·Claude를 확인해 주세요.');
    this.list.replaceChildren(node('p',text,'agent-completion-loading'));this.popup.hidden=false;this.position();this.input.setAttribute('aria-expanded','true');this.input.removeAttribute('aria-activedescendant');return;
   }this.index=sameQuery?Math.max(0,this.matches.findIndex(item=>item.insert===previous)):0;this.lastQuery=token.prefix+token.query;this.list.replaceChildren();
   this.caption.replaceChildren(node('span',(this.agent||'')+' '+(token.prefix==='$'?qLangAgentControls.t('스킬'):qLangAgentControls.t('명령'))),node('span',String(this.matches.length),'agent-completion-count'));
   for(const [index,item] of this.matches.entries()){
    const option=node('button','','agent-completion');option.type='button';option.setAttribute('role','option');option.id='agent-completion-'+index;option.dataset.index=index;
    const label=node('strong',item.insert);option.append(label,node('small',item.description||''),node('span','↵','agent-completion-enter'));option.title=item.insert+(item.description?'\n'+item.description:'');
    option.addEventListener('pointerdown',event=>event.preventDefault());option.onclick=()=>this.apply(item);this.list.append(option);
   }
   this.popup.hidden=false;this.position();this.input.setAttribute('aria-expanded','true');this.highlight();
  }
  position(){
   const rect=this.form.getBoundingClientRect(),view=window.visualViewport,top=view?.offsetTop||0,left=view?.offsetLeft||0,width=view?.width||innerWidth,height=view?.height||innerHeight;
   const above=rect.top-top-6,below=top+height-rect.bottom-6,up=above>=90||above>=below,available=Math.max(55,Math.min(360,(up?above:below)-8));
   Object.assign(this.popup.style,{left:Math.max(left+6,Math.min(rect.left,left+width-Math.min(660,rect.width)-6))+'px',width:Math.max(100,Math.min(660,rect.width,width-12))+'px',bottom:'auto',top:'0px',maxHeight:available+'px'});
   this.list.style.maxHeight=Math.max(30,available-this.caption.offsetHeight-32)+'px';
   const y=up?rect.top-this.popup.getBoundingClientRect().height-6:rect.bottom+6;
   this.popup.style.top=Math.max(top+6,Math.min(y,top+height-this.popup.getBoundingClientRect().height-6))+'px';
  }
  highlight(){for(const option of this.popup.querySelectorAll('[role=option]'))option.setAttribute('aria-selected',String(Number(option.dataset.index)===this.index));const selected=this.popup.querySelector('[aria-selected=true]');this.input.setAttribute('aria-activedescendant',selected.id);selected.scrollIntoView({block:'nearest'});}
  hide(){this.popup.hidden=true;this.input.setAttribute('aria-expanded','false');this.input.removeAttribute('aria-activedescendant');}
  apply(item){const token=this.token();if(!item||!token)return;this.input.setRangeText(item.insert+' ',token.start,token.end,'end');this.hide();this.input.focus({preventScroll:true});this.input.dispatchEvent(new Event('input',{bubbles:true}));this.hide();}
  mountModel(){
   if(this.dialog)return;
   this.dialog=node('dialog','','agent-model-dialog');const header=node('header'),title=node('strong',qLangAgentControls.t('모델 선택')),close=node('button',qLangAgentControls.t('닫기 ×'));close.type='button';close.onclick=()=>this.closeModel(true);header.append(title,close);
   this.modelStatus=node('p',qLangAgentControls.t('CLI 선택지를 불러오는 중…'),'agent-model-status');this.modelArea=node('div');this.dialog.append(header,this.modelStatus,this.modelArea);document.body.append(this.dialog);
   this.dialog.addEventListener('cancel',event=>{event.preventDefault();this.closeModel(true)});
   this.menu=new QuestionPanel({area:this.modelArea,fetch:async path=>{
    const data=await this.fetch(path);if(!this.dialog.open)return {interaction:null};
    if(data.interaction?.purpose==='model'){this.seenModel=true;this.emptyMenus=0;this.modelStatus.hidden=true;return data;}
    if(this.seenModel&&++this.emptyMenus>=2){this.closeModel(false);this.changed?.();}
    else if(!this.seenModel&&Date.now()-this.modelStarted>8000){this.notice(qLangAgentControls.t('모델 메뉴를 확인하지 못했어요. 원본 터미널에서 확인해 주세요.'));this.closeModel(false);}
    return {interaction:null};
   },send:this.send,notice:this.notice,changed:()=>{this.changed?.();this.pollModel()}});
  }
  async openModel(){
   const target=this.target,generation=this.generation;if(!target||this.opening)return;this.opening=true;this.hide();
   try{
    const current=await this.fetch('/api/panes/'+encodeURIComponent(target)+'/interaction');
    if(generation!==this.generation)return;
    if(current.interaction?.purpose!=='model'){
     const data=await this.fetch('/api/panes/'+encodeURIComponent(target)+'/catalog');if(generation!==this.generation)return;
     if(!data.model_ready){this.notice(data.model_reason);return;}
     await this.send({type:'agent_command',command:'model',token:data.command_token,request_id:crypto.randomUUID()},target);
    }
    if(generation!==this.generation)return;this.mountModel();this.modelStarted=Date.now();this.seenModel=false;this.emptyMenus=0;this.modelStatus.hidden=false;this.menu.select(target);this.dialog.showModal();this.pollModel();
   }catch(error){this.notice(error.message)}finally{this.opening=false;}
  }
  async pollModel(){clearTimeout(this.modelTimer);if(!this.dialog?.open)return;const target=this.target;await this.menu.poll();if(this.dialog.open&&this.target===target)this.modelTimer=setTimeout(()=>this.pollModel(),700);}
  async closeModel(cancel){
   clearTimeout(this.modelTimer);if(!this.dialog?.open)return;const target=this.menu.target;this.dialog.close();this.menu.select('');
   if(cancel){try{for(let attempt=0;attempt<3;attempt++){
    const data=await this.fetch('/api/panes/'+encodeURIComponent(target)+'/interaction');if(data.interaction?.purpose!=='model')break;
    await this.send({type:'interaction',token:data.interaction.token,key:'escape',request_id:crypto.randomUUID()},target);
    await new Promise(resolve=>setTimeout(resolve,120));
   }}catch(error){this.notice(error.message)}}
   this.model.focus({preventScroll:true});
  }
 }
 root.AgentControls=AgentControls;
})(globalThis);
