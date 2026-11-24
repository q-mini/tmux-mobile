(function(root){
  'use strict';
  const t=value=>root.QI18n?.t(value)??value;
  const byId=id=>document.getElementById(id),node=(tag,text='',className='')=>{const result=document.createElement(tag);result.textContent=text;result.className=className;return result;};
  const icon='<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z"/><path d="M10 21h4"/></svg>';
  class TmuxNotifications {
    constructor({api,openTarget,notice}){
      Object.assign(this,{api,openTarget,notice});this.items=[];this.version='';this.seen=new Set();this.buttons=[];this.running=false;this.loading=false;this.first=true;this.pushActive=false;this.deviceId='';
      try{this.enabled=localStorage.getItem('tmux-device-notifications')==='1';}catch{this.enabled=false;}
      this.dialog=byId('notifications-dialog');this.toast=byId('notification-toast');
      const device=this.dialog.querySelector('.notification-device');this.settings=node('details','','notification-settings');const settingsTitle=node('summary',t('기기 알림'));this.settingState=node('span','','notification-setting-state');settingsTitle.append(this.settingState);device.before(this.settings);this.settings.append(settingsTitle,device);
      const body=node('div','','notification-body');body.append(this.settings,byId('notifications-empty'),byId('notifications-list'));this.dialog.append(body);
      const fit=()=>this.fitViewport();root.addEventListener('resize',fit);root.visualViewport?.addEventListener('resize',fit);root.visualViewport?.addEventListener('scroll',fit);this.fitViewport();
      const shortcut=byId('question-alerts');if(shortcut)shortcut.onclick=()=>{this.openInbox();if(!this.enabled&&root.Notification?.permission!=='denied')this.configure();};
      byId('notifications-close').onclick=()=>this.dialog.close();byId('notifications-read').onclick=()=>this.read('all');byId('notifications-enable').onclick=()=>this.configure();byId('notifications-test').onclick=()=>this.test();
      this.dialog.addEventListener('click',event=>{if(event.target===this.dialog){const rect=this.dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)this.dialog.close();}});
      document.addEventListener('q-outside-press',event=>{
        const {target,x,y}=event.detail;
        if(!this.dialog.open)return;
        const rect=this.dialog.getBoundingClientRect();
        if(!this.dialog.contains(target)||target===this.dialog&&(x<rect.left||x>rect.right||y<rect.top||y>rect.bottom))this.dialog.close();
      });
      byId('notification-toast-close').onclick=()=>this.hideToast();byId('notification-toast-open').onclick=()=>this.open(this.toast.dataset.id);
      this.swipeDismiss(this.toast,()=>this.hideToast());const noticeBanner=byId('notice');if(noticeBanner)this.swipeDismiss(noticeBanner,()=>{noticeBanner.hidden=true;});
      document.addEventListener('visibilitychange',()=>{if(this.running&&!document.hidden)this.poll();});
      navigator.serviceWorker?.addEventListener('message',event=>{if(event.data?.type==='open-notification'&&/^[a-f0-9]{24}$/.test(event.data.id)){this.pendingOpen=event.data.id;if(this.running)this.poll(true);else{const url=new URL(location.href);url.searchParams.set('notification',event.data.id);history.replaceState(null,'',url.pathname+url.search);}}});
      this.permissionUI();
    }
    fitViewport(){const view=root.visualViewport;for(const element of [this.dialog,this.toast]){element.style.setProperty('--notification-vtop',(view?.offsetTop||0)+'px');element.style.setProperty('--notification-vright',Math.max(0,root.innerWidth-(view?.offsetLeft||0)-(view?.width||root.innerWidth))+'px');element.style.setProperty('--notification-vwidth',(view?.width||root.innerWidth)+'px');element.style.setProperty('--notification-vheight',(view?.height||root.innerHeight)+'px');}}
    swipeDismiss(element,dismiss){let start=null,suppressUntil=0;const reset=()=>{start=null;element.style.removeProperty('translate');element.style.removeProperty('opacity');};
      element.addEventListener('pointerdown',event=>{suppressUntil=0;if(event.pointerType!=='touch'||!event.isPrimary)return;reset();start={id:event.pointerId,x:event.clientX,y:event.clientY};});
      element.addEventListener('pointermove',event=>{if(!start||start.id!==event.pointerId)return;const dx=event.clientX-start.x,dy=event.clientY-start.y;if(Math.abs(dx)>Math.max(12,Math.abs(dy))){reset();return;}if(Math.abs(dy)>12){element.setPointerCapture(event.pointerId);element.style.translate='0 '+dy+'px';element.style.opacity=String(Math.max(.35,1-Math.abs(dy)/Math.max(80,element.offsetHeight)));}});
      element.addEventListener('pointerup',event=>{if(!start||start.id!==event.pointerId)return;const dx=event.clientX-start.x,dy=event.clientY-start.y,swiped=Math.abs(dy)>=Math.min(48,Math.max(20,element.offsetHeight*.3))&&Math.abs(dy)>Math.abs(dx)*1.5;reset();if(element.hasPointerCapture(event.pointerId))element.releasePointerCapture(event.pointerId);if(swiped){suppressUntil=Date.now()+500;dismiss();}});
      element.addEventListener('pointercancel',reset);element.addEventListener('click',event=>{if(Date.now()<suppressUntil){event.preventDefault();event.stopImmediatePropagation();}},true);
    }
    openInbox(){this.render();this.hideToast();this.fitViewport();if(!this.dialog.open)this.dialog.showModal();root.requestAnimationFrame(()=>this.fitViewport());}
    mount(parent){const button=node('button','','quiet notification-bell');button.type='button';button.setAttribute('aria-label','알림');button.setAttribute('aria-haspopup','dialog');button.innerHTML=icon;button.append(node('span','','notification-count'));button.onclick=()=>{this.openInbox();this.poll();};parent.append(button);this.buttons.push(button);return button;}
    start(){if(this.running)return;this.running=true;this.first=true;this.version='';this.pendingOpen=new URLSearchParams(location.search).get('notification')||this.pendingOpen;this.poll();this.preparing=this.prepare();}
    stop(){this.running=false;clearTimeout(this.timer);this.hideToast();this.dialog.close();}
    async prepare(){
      if(!('serviceWorker'in navigator))return null;
      try{await navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'});this.registration=await navigator.serviceWorker.ready;
        if(this.enabled&&root.Notification?.permission==='granted'&&this.registration.pushManager){const existing=await this.registration.pushManager.getSubscription();if(existing&&this.running){const saved=await this.api('/api/notifications/subscriptions',this.post({subscription:existing.toJSON()}));this.pushActive=true;this.deviceId=saved.id;}}
      }catch{this.pushActive=false;}this.permissionUI();return this.registration;
    }
    post(data){return{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)};}
    async poll(force=false){
      if(!this.running||this.loading)return;this.loading=true;clearTimeout(this.timer);
      try{const data=await this.api('/api/notifications?version='+encodeURIComponent(force?'':this.version));if(!this.running)return;this.config=data.push;this.version=data.version;
        if(data.changed){const fresh=data.items.filter(item=>!this.seen.has(item.id));this.items=data.items;this.seen=new Set(this.items.map(item=>item.id));
          if(!this.first)for(const item of fresh.reverse())if(!item.read){this.showToast(item);this.native(item);}this.first=false;this.render();}
        this.badge(data.unread);this.permissionUI();
        if(this.pendingOpen){const id=this.pendingOpen;this.pendingOpen='';await this.open(id);const url=new URL(location.href);url.searchParams.delete('notification');history.replaceState(null,'',url.pathname+url.search);}
      }catch(error){if(error.status===401)this.stop();}
      finally{this.loading=false;if(this.running)this.timer=setTimeout(()=>this.poll(),3000);}
    }
    badge(count){for(const button of this.buttons){button.classList.toggle('has-unread',count>0);button.setAttribute('aria-label',count?(root.QI18n?.f('알림, 읽지 않음 {0}개',[count])||'Notifications, '+count+' unread'):t('알림'));button.querySelector('span').textContent=count?String(Math.min(99,count)):'';}
      if(root.Notification?.permission==='granted'){if(count)navigator.setAppBadge?.(count).catch(()=>{});else navigator.clearAppBadge?.().catch(()=>{});}}
    render(){
      const list=byId('notifications-list');list.replaceChildren();byId('notifications-empty').hidden=this.items.length>0;byId('notifications-read').disabled=!this.items.some(item=>!item.read);
      for(const item of this.items){const button=node('button','','notification-item'+(item.read?'':' is-unread'));button.type='button';button.dataset.notification=item.id;button.title='이 질문의 작업 보기로 이동';
        const source=node('div','','notification-source'),agent=node('span',item.agent,'notification-agent');agent.dataset.agent=item.agent;source.append(node('strong',item.session_name),agent);
        button.append(source,node('p',item.title,'notification-question'));
        const meta=node('div','','notification-meta'),location=node('small',item.host_name+(item.pane_title?' · '+item.pane_title:''),'notification-location');location.title=location.textContent;const time=node('time',new Date(item.created_at*1000).toLocaleString(root.QI18n?.locale||'en-US',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}));time.dateTime=new Date(item.created_at*1000).toISOString();meta.append(location,time);button.append(meta);button.onclick=()=>this.open(item.id);list.append(button);
      }
    }
    async read(ids){try{const data=await this.api('/api/notifications/read',this.post({ids}));this.items=data.items;this.version=data.version;this.render();this.badge(data.unread);}catch(error){this.notice(error.message);}}
    async open(id){const item=this.items.find(item=>item.id===id);if(!item){this.notice('알림 목록에서 질문을 확인해 주세요.');this.openInbox();return;}
      try{await this.openTarget(item);this.dialog.close();this.hideToast();await this.read([id]);}catch(error){this.notice(error.message);}}
    showToast(item){if(this.dialog.open)return;this.fitViewport();this.toast.dataset.id=item.id;byId('notification-toast-source').textContent=item.host_name+' · '+item.session_name+' · '+item.agent;byId('notification-toast-title').textContent=item.title;this.toast.hidden=false;clearTimeout(this.toastTimer);this.toastTimer=setTimeout(()=>this.hideToast(),8000);}
    hideToast(){clearTimeout(this.toastTimer);this.toast.hidden=true;}
    async native(item){if(!this.enabled||this.pushActive||root.Notification?.permission!=='granted')return;
      const title=item.agent+' · '+item.session_name,options={body:item.host_name+' — '+item.title,icon:'/static/assets/icons/icon-192.png?v=blue-q1',tag:'tmux-question-'+item.id,data:{id:item.id,url:'/?notification='+item.id}};
      try{if(this.registration)await this.registration.showNotification(title,options);else{const notification=new Notification(title,options);notification.onclick=()=>{window.focus();this.open(item.id);notification.close();};}}catch{this.notice('기기 알림을 표시하지 못했어요. 종 버튼에서 질문을 확인해 주세요.');}}
    permissionUI(){
      const button=byId('notifications-enable'),status=byId('notifications-device-status'),permission=root.Notification?.permission;
      const ios=/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1),standalone=matchMedia('(display-mode: standalone)').matches||!!navigator.standalone;
      this.installNeeded=ios&&!standalone;button.disabled=false;
      this.settingState.textContent=this.installNeeded?'설치 필요':permission==='denied'?'허용 필요':this.enabled&&permission==='granted'?'켜짐':'꺼짐';
      if(this.installNeeded){button.textContent='홈 화면에 추가';status.textContent='아이폰 기기 알림은 홈 화면에 추가한 웹앱에서 켤 수 있어요.';}
      else if(!root.Notification){button.textContent='화면 알림 사용 중';button.disabled=true;status.textContent='질문이 오면 접속 중인 화면과 종 버튼에 표시해요.';}
      else if(permission==='denied'){button.textContent='알림 설정 안내';status.textContent='기기 설정에서 이 앱의 알림을 허용해 주세요. 화면 알림은 계속 표시돼요.';}
      else if(this.enabled&&permission==='granted'){button.textContent='이 기기 알림 끄기';status.textContent=this.pushActive?'기기 알림이 켜졌어요. 웹앱을 닫아도 질문 알림을 보내요.':'접속 중 기기 알림을 받아요.';}
      else{button.textContent='기기 알림 켜기';status.textContent='답변이 필요한 질문을 이 기기의 알림으로 받아요.';}
      byId('notifications-test').hidden=!(this.enabled&&permission==='granted');
      const shortcut=byId('question-alerts');if(shortcut)shortcut.textContent=this.pushActive?'질문 알림 켜짐':'질문 알림 켜기';
      if(this.enabled&&this.config?.error)status.textContent=this.config.error;
      root.QI18n?.translate(this.dialog);if(shortcut)root.QI18n?.translate(shortcut);
    }
    async configure(){
      if(this.installNeeded){this.dialog.close();if(root.AppLauncher)root.AppLauncher.install();else byId('install-dialog')?.showModal();return;}
      if(root.Notification?.permission==='denied'){this.notice('기기 설정에서 이 웹앱의 알림을 허용해 주세요.');return;}
      if(this.enabled&&root.Notification?.permission==='granted')return this.disable();
      // Keep the permission request in the button's user gesture, before network awaits.
      const permission=root.Notification?.permission==='granted'?Promise.resolve('granted'):root.Notification?.requestPermission();
      if(await permission!=='granted'){this.permissionUI();return;}
      this.enabled=true;try{localStorage.setItem('tmux-device-notifications','1');}catch{}
      try{if(!this.config)await this.poll();const registration=this.registration||await(this.preparing||this.prepare());if(registration?.pushManager&&this.config?.public_key){
        const value=this.config.public_key.replace(/-/g,'+').replace(/_/g,'/'),key=Uint8Array.from(atob(value+'='.repeat((4-value.length%4)%4)),char=>char.charCodeAt(0));
        const subscription=await registration.pushManager.getSubscription()||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
        const saved=await this.api('/api/notifications/subscriptions',this.post({subscription:subscription.toJSON()}));this.deviceId=saved.id;this.pushActive=true;
      }}catch{this.pushActive=false;this.notice('푸시 연결을 완료하지 못했어요. 접속 중 알림을 사용해요.');}this.permissionUI();
    }
    async disable(){try{if(this.deviceId)await this.api('/api/notifications/subscriptions/'+this.deviceId,{method:'DELETE'});const existing=await this.registration?.pushManager?.getSubscription();await existing?.unsubscribe();}catch{this.notice('기기 알림 연결을 다시 확인해 주세요.');return;}
      this.enabled=false;this.pushActive=false;this.deviceId='';try{localStorage.setItem('tmux-device-notifications','0');}catch{}this.permissionUI();}
    async test(){try{if(this.pushActive){await this.api('/api/notifications/test',this.post({id:this.deviceId}));this.notice('이 기기로 테스트 알림을 보냈어요.');}
      else await this.native({id:'test-'+Date.now(),agent:'Q tmux',session_name:'테스트 알림',host_name:'이 기기',title:'앞으로 답변이 필요한 질문을 이곳으로 보내요.'});}catch(error){this.notice(error.message);}}
  }
  root.TmuxNotifications=TmuxNotifications;
})(globalThis);
