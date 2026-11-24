const qLangTerminalTouch=globalThis.QI18n||{t:value=>value,html:value=>value,f:(key,values)=>key.replace(/\{(\d+)\}/g,(_,index)=>String(values[index]??'')),locale:'ko-KR'};
/* Touch gestures change only this browser's view; history never sends tmux keys. */
(function(root){
  'use strict';
  class TerminalTouch {
    constructor({area,history,fit,load,notice,mobile,onZoom=()=>{},tap=()=>{}}){
      Object.assign(this,{area,history,fit,load,notice,mobile,onZoom,tap});this.defaultZoom=1;
      this.zoom=1;this.target='';this.generation=0;this.limit=800;this.more=false;this.loading=false;this.views=new Map();
      document.getElementById('terminal-zoom-in').addEventListener('click',()=>this.zoomTo(this.zoom*1.4));
      document.getElementById('terminal-zoom-out').addEventListener('click',()=>this.zoomTo(this.zoom/1.4));
      document.getElementById('terminal-past').addEventListener('click',()=>this.history.hidden?this.older():this.live());
      area.addEventListener('scroll',()=>{if(!history.hidden&&area.scrollTop<90&&this.more&&!this.loading)this.older(true);});
      for(const type of ['touchstart','touchmove','touchend','touchcancel'])area.addEventListener(type,event=>this.touch(event),{capture:true,passive:false});
    }
    select(target){
      if(target===this.target)return;
      this.views.set(this.target,this.zoom);this.target=target;this.generation++;this.zoom=this.views.get(target)||this.defaultZoom;this.onZoom(this.zoom);
      this.limit=800;this.more=false;this.loading=false;this.gesture=null;this.history.hidden=true;this.history.replaceChildren();this.area.scrollTop=0;this.area.scrollLeft=0;
      const button=document.getElementById('terminal-past');button.textContent=qLangTerminalTouch.t('이전 출력');button.disabled=false;
    }
    zoomTo(value,point){
      const next=Math.max(.2,Math.min(5,value));if(Math.abs(next-this.zoom)<.001)return;
      const rect=this.area.getBoundingClientRect(),x=point?.x??rect.width/2,y=point?.y??rect.height/2;
      const ratio=next/this.zoom,left=(this.area.scrollLeft+x)*ratio-x,top=(this.area.scrollTop+y)*ratio-y;
      this.zoom=next;this.onZoom(next);this.fit();this.area.scrollLeft=Math.max(0,left);this.area.scrollTop=Math.max(0,top);
    }
    fitHistory(scale){
      const pre=this.history.firstElementChild;if(!pre||this.history.hidden)return;
      pre.style.transform=`scale(${scale})`;
      this.history.style.width=Math.ceil(pre.scrollWidth*scale)+'px';this.history.style.height=Math.ceil(pre.offsetHeight*scale)+'px';
    }
    live(){this.history.hidden=true;document.getElementById('terminal-past').textContent=qLangTerminalTouch.t('이전 출력');this.fit();this.area.scrollTop=this.area.scrollHeight;}
    reset(){this.zoom=1;this.onZoom(1);this.live();this.area.scrollLeft=0;}
    async older(prepend=false){
      if(this.loading||!this.target)return;
      this.loading=true;const generation=this.generation,target=this.target;
      const button=document.getElementById('terminal-past');button.disabled=true;
      try{
        const limit=prepend?Math.min(100000,this.limit+1600):this.limit;
        const data=await this.load(target,limit);if(generation!==this.generation)return;
        if(!data.ansi){this.notice(qLangTerminalTouch.t('이 화면에 남아 있는 이전 출력이 없어요.'));return;}
        const oldHeight=this.area.scrollHeight,oldTop=this.area.scrollTop;
        this.limit=limit;this.more=data.history_more;this.history.replaceChildren(root.TmuxReader.renderGrid(data.ansi));
        this.history.hidden=false;button.textContent=qLangTerminalTouch.t('실시간 ↓');this.fit();
        this.area.scrollTop=prepend?oldTop+this.area.scrollHeight-oldHeight:Math.max(0,this.history.offsetHeight-this.area.clientHeight*.65);
      }catch(error){if(generation===this.generation)this.notice(error.message);}
      finally{if(generation===this.generation){this.loading=false;button.disabled=false;}}
    }
    touch(event){
      if(!this.mobile())return;
      event.preventDefault();event.stopPropagation();
      const touches=Array.from(event.touches),rect=this.area.getBoundingClientRect();
      if(event.type==='touchend'||event.type==='touchcancel'){
        const gesture=this.gesture;
        if(!touches.length){this.gesture=null;
          if(event.type==='touchend'&&gesture?.kind==='pan'&&gesture.clickable&&!gesture.moved&&this.history.hidden&&Date.now()-gesture.started<500)this.tap({clientX:gesture.x,clientY:gesture.y});
        }else if(gesture)gesture.clickable=false;
        return;
      }
      if(touches.length>=2){
        const [a,b]=touches,distance=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY),point={x:(a.clientX+b.clientX)/2-rect.left,y:(a.clientY+b.clientY)/2-rect.top};
        if(event.type==='touchstart'||this.gesture?.kind!=='pinch')this.gesture={kind:'pinch',distance,zoom:this.zoom};
        else this.zoomTo(this.gesture.zoom*distance/Math.max(1,this.gesture.distance),point);
        return;
      }
      if(!touches.length)return;
      const touch=touches[0];
      if(event.type==='touchstart'||this.gesture?.kind!=='pan'){this.gesture={kind:'pan',x:touch.clientX,y:touch.clientY,startX:touch.clientX,startY:touch.clientY,travel:0,started:Date.now(),clickable:event.type==='touchstart'&&touches.length===1&&this.history.hidden,moved:false};return;}
      const dx=this.gesture.x-touch.clientX,dy=this.gesture.y-touch.clientY;this.gesture.x=touch.clientX;this.gesture.y=touch.clientY;this.gesture.travel-=dy;
      if(Math.hypot(touch.clientX-this.gesture.startX,touch.clientY-this.gesture.startY)>7)this.gesture.moved=true;
      this.area.scrollLeft+=dx;this.area.scrollTop+=dy;
      if(this.history.hidden&&this.area.scrollTop<2&&this.gesture.travel>24)this.older();
    }
  }
  root.TerminalTouch=TerminalTouch;
})(globalThis);
