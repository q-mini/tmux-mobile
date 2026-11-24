const qLangViewZoom=globalThis.QI18n||{t:value=>value,html:value=>value,f:(key,values)=>key.replace(/\{(\d+)\}/g,(_,index)=>String(values[index]??'')),locale:'ko-KR'};
/* Local region zoom. Browser zoom and terminal input never share these gestures. */
(function(root){
  'use strict';
  const labels={reader:qLangViewZoom.t('작업 보기'),terminal:qLangViewZoom.t('원본 터미널'),sidebar:qLangViewZoom.t('왼쪽 목록'),composer:qLangViewZoom.t('입력 글자')};
  const selector='#reader-scroll,#terminal-scroll,#reader-session-sidebar,#terminal-session-sidebar,#compose-form,#reader-live-status,.reader-footer,.terminal-fit-info';
  class ViewZoom {
    constructor({apply,mode,enabled,mobile,changed=()=>{}}){
      Object.assign(this,{apply,mode,enabled,mobile,changed});this.values={reader:1,terminal:1,sidebar:1,composer:1};this.hover=null;this.menus=[];
      try{const saved=JSON.parse(localStorage.getItem('tmux-view-zoom-v1'));for(const region of Object.keys(this.values))if(Number.isFinite(saved?.[region]))this.values[region]=this.clamp(region,saved[region]);}catch{}
      document.addEventListener('pointermove',event=>{this.hover=this.region(event.target);},{passive:true});
      window.addEventListener('keydown',event=>this.key(event),true);
      window.addEventListener('wheel',event=>this.wheel(event),{capture:true,passive:false});
      for(const type of ['touchstart','touchmove','touchend','touchcancel'])document.addEventListener(type,event=>this.touch(event),{capture:true,passive:false});
      window.addEventListener('resize',()=>this.position());window.visualViewport?.addEventListener('resize',()=>this.position());
      document.addEventListener('pointerdown',event=>{for(const menu of this.menus)if(!menu.contains(event.target))menu.open=false;},true);
    }
    clamp(region,value){return Math.round(Math.max(.2,Math.min(5,value))*1000)/1000;}
    save(){try{localStorage.setItem('tmux-view-zoom-v1',JSON.stringify(this.values));}catch{}}
    set(region,value,point){
      if(!(region in this.values)||!Number.isFinite(value))return;
      const next=this.clamp(region,value),previous=this.values[region];if(next===previous)return;
      this.values[region]=next;this.apply(region,next,previous,point);this.save();this.refresh();this.changed();
    }
    rememberTerminal(value){this.values.terminal=value;this.save();this.refresh();this.changed();}
    step(region,direction,point){this.set(region,direction===0?1:this.values[region]*Math.pow(1.1,direction),point);}
    active(){return this.enabled()&&!document.querySelector('dialog[open]');}
    region(target){
      if(!(target instanceof Element))return null;
      const row=target.closest('[data-zoom-region]');if(row)return row.dataset.zoomRegion;
      const node=target.closest(selector);if(!node)return target.closest('.reader-heading')?'reader':target.closest('.terminal-heading')?'terminal':null;
      if(node.id.includes('sidebar'))return 'sidebar';
      if(node.id==='reader-scroll')return 'reader';if(node.id==='terminal-scroll')return 'terminal';return 'composer';
    }
    key(event){
      if(!this.active()||(!event.ctrlKey&&!event.metaKey)||event.altKey||event.isComposing||event.keyCode===229)return;
      const direction=['+','='].includes(event.key)||event.code==='NumpadAdd'?1:['-','_','−'].includes(event.key)||event.code==='NumpadSubtract'?-1:event.key==='0'||event.code==='Numpad0'?0:null;
      if(direction===null)return;
      event.preventDefault();event.stopImmediatePropagation();
      this.step(this.hover||this.region(document.activeElement)||this.mode(),direction);
    }
    wheel(event){
      if(!this.active()||(!event.ctrlKey&&!event.metaKey)||event.altKey)return;
      const region=this.region(event.target)||(event.target.closest?.('#task-view')?this.mode():null);if(!region||!event.deltaY)return;
      event.preventDefault();event.stopImmediatePropagation();this.hover=region;
      const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?innerHeight:1);
      this.set(region,this.values[region]*Math.exp(-Math.max(-150,Math.min(150,delta))*.002),{x:event.clientX,y:event.clientY});
    }
    touch(event){
      if(!this.active()||!this.mobile())return;
      if(event.type==='touchend'||event.type==='touchcancel'){if(this.gesture&&event.touches.length<2){event.preventDefault();event.stopImmediatePropagation();this.gesture=null;}return;}
      // A sidebar refresh can detach a pinch target before its final touchend.
      // A new single-finger gesture must never inherit that unfinished pinch.
      if(event.touches.length<2){if(event.type==='touchstart')this.gesture=null;return;}
      const region=this.region(event.target);if(!region||region==='terminal')return; // Original terminal keeps its pan/history gestures.
      event.preventDefault();event.stopImmediatePropagation();const [a,b]=event.touches,distance=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY),point={x:(a.clientX+b.clientX)/2,y:(a.clientY+b.clientY)/2};
      if(event.type==='touchstart'||this.gesture?.region!==region)this.gesture={region,distance,value:this.values[region]};
      else this.set(region,this.gesture.value*distance/Math.max(1,this.gesture.distance),point);
    }
    mount(host,controls=this){
      const menu=document.createElement('details');menu.className='view-zoom';const summary=document.createElement('summary');summary.textContent=qLangViewZoom.t('크기');summary.title=qLangViewZoom.t('영역별 크기 조절');menu.append(summary);
      const panel=document.createElement('div');panel.className='view-zoom-panel';panel.setAttribute('aria-label',qLangViewZoom.t('영역별 크기 조절'));
      for(const [region,label] of Object.entries(labels)){
        const row=document.createElement('div');row.className='view-zoom-row';row.dataset.zoomRegion=region;const name=document.createElement('span');name.textContent=label;row.append(name);
        for(const [text,direction,title] of [['−',-1,qLangViewZoom.t('축소')],['100%',0,qLangViewZoom.t('기본 크기')],['＋',1,qLangViewZoom.t('확대')]]){
          const button=document.createElement('button');button.type='button';button.textContent=text;button.dataset.zoomStep=direction;button.setAttribute('aria-label',label+' '+title);button.addEventListener('click',()=>{if(controls===this)this.hover=region;controls.step(region,direction);});row.append(button);
        }panel.append(row);
      }
      const hint=document.createElement('p');hint.textContent=qLangViewZoom.t('20–500% · Ctrl/⌘ ± · Ctrl 휠');panel.append(hint);menu.append(panel);host.append(menu);this.menus.push(menu);
      menu.refresh=()=>{for(const row of menu.querySelectorAll('[data-zoom-region]'))row.querySelector('[data-zoom-step="0"]').textContent=Math.round(controls.values[row.dataset.zoomRegion]*100)+'%';};
      menu.dispose=()=>{this.menus=this.menus.filter(item=>item!==menu);menu.remove();};
      menu.addEventListener('toggle',()=>{if(menu.open){for(const other of this.menus)if(other!==menu)other.open=false;this.position();}});this.refresh();return menu;
    }
    refresh(){for(const menu of this.menus)menu.refresh();}
    position(){for(const menu of this.menus){if(!menu.open)continue;const rect=menu.firstElementChild.getBoundingClientRect(),panel=menu.lastElementChild,viewport=visualViewport,left=viewport?.offsetLeft||0,top=viewport?.offsetTop||0,width=viewport?.width||innerWidth,height=viewport?.height||innerHeight;
      panel.style.left=Math.max(left+6,Math.min(rect.right-254,left+width-260))+'px';panel.style.top=Math.max(top+6,Math.min(rect.bottom+6,top+height-panel.offsetHeight-6))+'px';}}
  }
  root.ViewZoom=ViewZoom;
})(globalThis);
