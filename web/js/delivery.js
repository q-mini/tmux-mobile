const qLangDelivery=globalThis.QI18n||{t:value=>value,html:value=>value,f:(key,values)=>key.replace(/\{(\d+)\}/g,(_,index)=>String(values[index]??'')),locale:'ko-KR'};
/* The send-now action flushes the CLI's queue; it never pastes the message again. */
(function(root){
  'use strict';
  class PendingDelivery {
    constructor({form,fetch,send,notice,changed=()=>{}}){
      Object.assign(this,{fetch,send,notice,changed});this.target='';this.generation=0;this.request=0;this.running=false;this.intents=new Map();
      this.area=document.createElement('div');this.area.id='pending-delivery';this.area.hidden=true;this.area.setAttribute('role','status');
      this.summary=document.createElement('div');this.label=document.createElement('span');this.preview=document.createElement('p');this.preview.className='pending-delivery-preview';this.summary.append(this.label,this.preview);this.button=document.createElement('button');this.button.type='button';this.button.setAttribute('aria-label',qLangDelivery.t('지금 바로 보내기'));this.button.title=qLangDelivery.t('대기 중인 메시지 지금 바로 보내기');this.button.innerHTML=qLangDelivery.html('<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 15 15 5M5 5h10v10"/></svg><span>지금 보내기</span>');this.button.onclick=()=>this.act();this.area.append(this.summary,this.button);form.append(this.area);
      document.addEventListener('visibilitychange',()=>{if(!document.hidden&&this.running&&this.target)this.poll();});
    }
    start(){if(this.running)return;this.running=true;if(this.target)this.poll();}
    stop(){this.running=false;this.generation++;clearTimeout(this.timer);this.area.hidden=true;this.frame=null;}
    select(target){if(this.target===target)return;this.target=target;this.generation++;clearTimeout(this.timer);this.area.hidden=true;this.frame=null;if(this.running&&target)this.poll();}
    submitted(target){this.intents.delete(target);if(target===this.target&&this.running)this.poll();}
    async poll(){
      if(!this.running||!this.target||document.hidden||this.acting)return;clearTimeout(this.timer);
      const target=this.target,generation=this.generation,request=++this.request;
      try{const data=await this.fetch('/api/panes/'+encodeURIComponent(target)+'/pending-input');if(target!==this.target||generation!==this.generation||request!==this.request||!this.running)return;
        this.frame=data.pending;this.area.hidden=!this.frame;
        if(this.frame){this.label.textContent=this.frame.agent+qLangDelivery.t(' · 전달 대기');this.preview.textContent=this.frame.preview.replace(/^\s*[❯›>]\s*/gm,'');this.area.title=this.frame.preview;this.button.disabled=false;}
        else this.intents.delete(target);
        this.changed(!!this.frame);
      }catch{if(target===this.target&&generation===this.generation){this.area.hidden=true;this.frame=null;}}
      finally{if(this.running&&this.target===target&&this.generation===generation&&this.request===request)this.timer=setTimeout(()=>this.poll(),1200);}
    }
    async act(){
      const target=this.target,frame=this.frame;if(!target||!frame||this.acting)return;
      this.acting=true;this.request++;this.button.disabled=true;clearTimeout(this.timer);
      let intent=this.intents.get(target);if(!intent||intent.token!==frame.token){intent={token:frame.token,request_id:crypto.randomUUID()};this.intents.set(target,intent);}
      try{await this.send({type:'send_now',token:frame.token,request_id:intent.request_id},target);if(target===this.target)this.area.hidden=true;}
      catch(error){this.notice(error.message);}
      finally{this.acting=false;if(this.running&&this.target)this.timer=setTimeout(()=>this.poll(),350);}
    }
  }
  root.PendingDelivery=PendingDelivery;
})(globalThis);
