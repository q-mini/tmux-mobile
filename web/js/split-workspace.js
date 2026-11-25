const qLangSplitWorkspace=globalThis.QI18n||{t:value=>value,html:value=>value,f:(key,values)=>key.replace(/\{(\d+)\}/g,(_,index)=>String(values[index]??'')),locale:'ko-KR'};
'use strict';

// Each visible panel owns its reader, terminal and drafts. Frames stay in place
// when the layout changes: moving/rebuilding an iframe would reload its editor.
class TmuxSplitWorkspace {
  constructor({sessions,hosts,label,hostLabel,manager,notice,connect,manageHost,addHost,manageSession,zoom,zoomMenu}) {
    Object.assign(this,{sessions,hosts,label,hostLabel,manager,notice,connect,manageHost,addHost,manageSession,zoom,zoomMenu});
    this.panels=new Map();this.tree=null;this.active='';this.serial=0;this.visible=false;
    this.shell=document.createElement('section');this.shell.id='split-workspace';this.shell.hidden=true;
    this.shell.setAttribute('aria-label',qLangSplitWorkspace.t('tmux 작업 공간'));
    this.shell.innerHTML=qLangSplitWorkspace.html('<aside class="split-sidebar"><button class="split-home" type="button" title="내 작업">Q <span>내 작업</span></button><p class="split-help">길게 눌러 끌면 분할</p><nav aria-label="tmux 작업 선택"></nav><button class="split-add" type="button">분할 ＋</button></aside><div class="split-stage"><div class="split-canvas"></div></div><div class="split-drop-layer" hidden><div class="split-drop-preview"></div><span class="split-drop-label"></span></div><div class="split-menu" hidden></div>');
    document.body.append(this.shell);this.list=this.shell.querySelector('nav');this.stage=this.shell.querySelector('.split-stage');this.canvas=this.shell.querySelector('.split-canvas');this.layer=this.shell.querySelector('.split-drop-layer');this.preview=this.shell.querySelector('.split-drop-preview');this.dropLabel=this.shell.querySelector('.split-drop-label');this.menu=this.shell.querySelector('.split-menu');
    this.shell.querySelector('.split-help').textContent=qLangSplitWorkspace.t('길게 눌러 이동·분할');
    this.shell.querySelector('.split-sidebar').dataset.zoomRegion='sidebar';
    this.sidebar=this.shell.querySelector('.split-sidebar');this.sidebarWidth=null;
    this.windows=new TmuxAuxiliaryWindows(this);
    try{const saved=Number(localStorage.getItem('tmux-split-sidebar-width'));if(Number.isFinite(saved)&&saved>=64&&saved<=480)this.sidebarWidth=saved;}catch{}
    this.sidebarHandle=document.createElement('div');this.sidebarHandle.className='split-sidebar-resize';this.sidebarHandle.tabIndex=0;
    for(const [name,value] of Object.entries({role:'separator','aria-label':qLangSplitWorkspace.t('내 작업 너비 조절'),'aria-orientation':'vertical','aria-controls':'split-session-list'}))this.sidebarHandle.setAttribute(name,value);
    this.sidebarHandle.title=qLangSplitWorkspace.t('끌어서 내 작업 너비 조절 · 두 번 누르면 기본 너비');this.sidebar.append(this.sidebarHandle);
    this.sidebarHandle.addEventListener('pointerdown',event=>this.resizeSidebar(event));
    this.sidebarHandle.addEventListener('dblclick',()=>{this.sidebarWidth=null;try{localStorage.removeItem('tmux-split-sidebar-width');}catch{}this.layout();});
    this.sidebarHandle.addEventListener('keydown',event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      event.preventDefault();const {min,max}=this.sidebarLimits(),current=this.sidebar.getBoundingClientRect().width;
      this.setSidebarWidth(event.key==='Home'?min:event.key==='End'?max:current+(event.key==='ArrowLeft'?-16:16));this.saveSidebarWidth();
    });
    this.list.id='split-session-list';this.sidebarToggle=document.createElement('button');this.sidebarToggle.type='button';this.sidebarToggle.className='split-sidebar-toggle';this.sidebarToggle.setAttribute('aria-controls','split-session-list');
    const tools=document.createElement('div');tools.className='split-sidebar-tools';this.shell.querySelector('.split-home').after(tools);tools.append(this.sidebarToggle);const text=document.createElement('span');text.textContent=qLangSplitWorkspace.t('크기');tools.append(text);
    for(const [direction,label,caption] of [[-1,'−',qLangSplitWorkspace.t('왼쪽 목록 축소')],[1,'＋',qLangSplitWorkspace.t('왼쪽 목록 확대')]]){const button=document.createElement('button');button.type='button';button.className='split-sidebar-font';button.textContent=label;button.setAttribute('aria-label',caption);button.title=caption;button.addEventListener('click',()=>{const current=parseFloat(getComputedStyle(this.shell).getPropertyValue('--sidebar-zoom'))||1;this.zoom(current*Math.pow(1.1,direction));});tools.append(button)}
    let folded=false;try{folded=localStorage.getItem('tmux-split-sidebar-collapsed')==='1';}catch{}
    const fold=value=>{this.sidebarResizeEnd?.();this.shell.classList.toggle('sidebar-collapsed',value);this.sidebarToggle.innerHTML='<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+(value?'m7 4 6 6-6 6':'m13 4-6 6 6 6')+'"/></svg><span>'+(value?qLangSplitWorkspace.t('펼치기'):qLangSplitWorkspace.t('접기'))+'</span>';this.sidebarToggle.setAttribute('aria-expanded',String(!value));this.sidebarToggle.setAttribute('aria-label',value?qLangSplitWorkspace.t('내 작업 목록 펼치기'):qLangSplitWorkspace.t('내 작업 목록 접기'));this.sidebarToggle.title=value?qLangSplitWorkspace.t('내 작업 목록 펼치기'):qLangSplitWorkspace.t('내 작업 목록 접기');try{localStorage.setItem('tmux-split-sidebar-collapsed',value?'1':'0');}catch{}this.menu.hidden=true;this.layout();};
    this.sidebarToggle.addEventListener('click',()=>fold(!this.shell.classList.contains('sidebar-collapsed')));fold(folded);
    this.shell.querySelector('.split-home').addEventListener('click',()=>this.manager());
    this.shell.querySelector('.split-add').addEventListener('click',()=>this.showMenu());
    const addServer=document.createElement('button');addServer.type='button';addServer.className='split-new-session';addServer.textContent=qLangSplitWorkspace.t('서버 ＋');addServer.addEventListener('click',()=>this.addHost());this.shell.querySelector('.split-add').before(addServer);
    document.addEventListener('q-outside-press',event=>{const target=event.detail.target;if(!this.menu.contains(target)&&!this.shell.querySelector('.split-add').contains(target))this.menu.hidden=true;});
    this.layer.addEventListener('dragover',event=>{if(!this.drag)return;event.preventDefault();event.dataTransfer.dropEffect=this.drag.panel?'move':'copy';this.point(event.clientX,event.clientY);});
    this.layer.addEventListener('drop',event=>{if(!this.drag)return;event.preventDefault();this.point(event.clientX,event.clientY);this.finishDrag();});
    document.addEventListener('dragend',()=>this.cancelDrag());
    document.addEventListener('keydown',event=>{if(event.key==='Escape'){this.cancelDrag();this.menu.hidden=true;}});
    document.addEventListener('touchmove',event=>this.touchMove(event),{passive:false});
    document.addEventListener('touchend',()=>{clearTimeout(this.holdTimer);if(this.drag?.touch)this.finishDrag();this.touch=null;});
    document.addEventListener('touchcancel',()=>{clearTimeout(this.holdTimer);this.touch=null;this.cancelDrag();});
    document.addEventListener('pointermove',event=>{
      if(!this.mouse)return;
      if(!this.drag&&Math.hypot(event.clientX-this.mouse.x,event.clientY-this.mouse.y)>7){this.beginDrag(this.mouse.session,false);if(this.mouse.panel)this.drag.panel=this.mouse.panel;}
      if(this.drag){event.preventDefault();this.point(event.clientX,event.clientY);}
    });
    document.addEventListener('pointerup',event=>{clearTimeout(this.mouseTimer);if(this.mouse&&this.drag){if(this.drag.panel&&(event.clientX<0||event.clientY<0||event.clientX>innerWidth||event.clientY>innerHeight)){const id=this.drag.panel;this.cancelDrag();this.windows.detach(id);}else this.finishDrag();}this.mouse=null;});
    document.addEventListener('pointercancel',()=>{clearTimeout(this.mouseTimer);this.mouse=null;this.cancelDrag();});
    window.addEventListener('message',event=>this.message(event));
    window.addEventListener('resize',()=>this.layout());
    window.visualViewport?.addEventListener('resize',()=>this.viewport());
    window.visualViewport?.addEventListener('scroll',()=>this.viewport());
    new ResizeObserver(()=>this.layout()).observe(this.stage);
    this.stage.addEventListener('pointerdown',()=>this.menu.hidden=true);
    this.viewport();
  }
  sidebarLimits(){
    const style=getComputedStyle(this.shell),available=this.shell.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),small=available<=600;
    const max=Math.max(64,Math.min(480,available-(small?240:300)));
    return {min:Math.min(small?64:80,max),max,small};
  }
  fitSidebar(){
    const {min,max,small}=this.sidebarLimits(),zoom=parseFloat(getComputedStyle(this.shell).getPropertyValue('--sidebar-zoom'))||1;
    const width=Math.round(Math.max(min,Math.min(max,this.sidebarWidth??(small?104:168)*zoom)));
    this.shell.style.setProperty('--split-sidebar-width',width+'px');
    for(const [key,value] of Object.entries({min,max,now:width}))this.sidebarHandle.setAttribute('aria-value'+key,String(Math.round(value)));
    this.sidebarHandle.setAttribute('aria-valuetext',width+'px');
  }
  setSidebarWidth(width){const {min,max}=this.sidebarLimits();this.sidebarWidth=Math.round(Math.max(min,Math.min(max,width)));this.layout();}
  saveSidebarWidth(){try{localStorage.setItem('tmux-split-sidebar-width',String(this.sidebarWidth));}catch{}}
  resizeSidebar(event){
    if(event.button!==0||!event.isPrimary||this.shell.classList.contains('sidebar-collapsed'))return;
    event.preventDefault();event.stopPropagation();this.sidebarResizeEnd?.();this.cancelDrag();this.menu.hidden=true;
    const start=event.clientX,initial=this.sidebar.getBoundingClientRect().width,pointer=event.pointerId;
    this.sidebarHandle.setPointerCapture(pointer);this.layer.hidden=false;this.layer.classList.add('is-resizing');this.shell.classList.add('sidebar-resizing');this.preview.hidden=true;
    const move=event=>{if(event.pointerId!==pointer)return;event.preventDefault();this.setSidebarWidth(initial+event.clientX-start);};
    const finish=()=>{
      window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',up);window.removeEventListener('keydown',key);
      if(this.sidebarHandle.hasPointerCapture(pointer))this.sidebarHandle.releasePointerCapture(pointer);
      this.layer.hidden=true;this.layer.classList.remove('is-resizing');this.shell.classList.remove('sidebar-resizing');this.preview.hidden=false;this.sidebarResizeEnd=null;
      if(this.sidebarWidth!==null)this.saveSidebarWidth();
    };
    const up=event=>{if(event.pointerId===pointer)finish();},key=event=>{if(event.key==='Escape')finish();};this.sidebarResizeEnd=finish;
    window.addEventListener('pointermove',move,{passive:false});window.addEventListener('pointerup',up);window.addEventListener('pointercancel',up);window.addEventListener('keydown',key);
  }
  viewport(){
    const v=window.visualViewport,top=v?.offsetTop||0,left=v?.offsetLeft||0,width=v?.width||innerWidth,header=document.querySelector('.app-header');
    // Keep the application bar inside the visible viewport. The workspace starts
    // below it; only this outer shell owns device safe areas, never each frame.
    if(this.visible)Object.assign(header.style,{top:top+'px',left:left+'px',width:width+'px'});
    const heading=this.visible?header.getBoundingClientRect().height:0;
    Object.assign(this.shell.style,{top:(top+heading)+'px',left:left+'px',width:width+'px',height:Math.max(0,(v?.height||innerHeight)-heading)+'px'});this.layout();
  }
  leaves(node=this.tree){return !node?[]:node.panel?[node.panel]:[...this.leaves(node.first),...this.leaves(node.second)];}
  panelMinimum(){return this.shell.clientWidth<=600?{w:180,h:260}:{w:300,h:280};}
  minimum(node){if(node.panel)return this.panelMinimum();const a=this.minimum(node.first),b=this.minimum(node.second);return node.axis==='x'?{w:a.w+b.w+6,h:Math.max(a.h,b.h)}:{w:Math.max(a.w,b.w),h:a.h+b.h+6};}
  start(linked,view){
    if(this.tree){if(linked)this.select(linked,view);else this.show();return;}
    if(this.windows.auxiliary){if(linked)this.open(linked,'reader');return;}
    if(this.windows.rejoin){this.show();return;}
    let saved;try{saved=JSON.parse(localStorage.getItem('tmux-split-layout-v1'));}catch{}
    const restore=(node,depth=0)=>{
      if(!node||depth>32||this.panels.size>=256)return null;
      if(typeof node.session==='string'){
        if(!this.sessions().some(item=>item.id===node.session))return null;
        const id=this.create(node.session,node.view);if(node.pane)this.send(this.panels.get(id),{action:'pane',pane:node.pane});
        return {panel:id};
      }
      if(!['x','y'].includes(node.axis))return null;
      const first=restore(node.first,depth+1),second=restore(node.second,depth+1);
      return first&&second?{axis:node.axis,ratio:Math.min(.9,Math.max(.1,Number(node.ratio)||.5)),first,second}:first||second;
    };
    this.tree=restore(saved?.tree);this.active=this.leaves()[Math.min(saved?.active||0,this.panels.size-1)]||'';
    this.windows.restore(saved);
    if(linked)this.select(linked,view);
    else if(this.tree||this.windows.records.size)this.show();
    else {const remembered=localStorage.getItem('tmux-mobile-session');if(this.sessions().some(item=>item.id===remembered))this.open(remembered);}
  }
  open(session,view){if(!this.tree){const id=this.create(session,view);this.tree={panel:id};this.active=id;this.show();this.save();}else this.select(session,view);}
  create(session,view='reader'){
    const id='split-'+(++this.serial),box=document.createElement('section');box.className='split-panel';box.dataset.panel=id;
    const heading=document.createElement('header');heading.className='split-panel-heading';
    const focus=document.createElement('button');focus.type='button';focus.className='split-panel-title';focus.addEventListener('click',()=>this.focus(id));
    const close=document.createElement('button');close.type='button';close.className='split-panel-close';close.textContent='×';close.setAttribute('aria-label',qLangSplitWorkspace.t('창 닫기'));close.title=qLangSplitWorkspace.t('이 창만 닫기');close.addEventListener('click',()=>this.close(id));
    heading.append(focus);const frame=document.createElement('iframe');frame.className='split-frame';frame.title=qLangSplitWorkspace.t('tmux 작업 화면');
    const link=new URL(location.pathname,location.origin);link.searchParams.set('panel','1');link.searchParams.set('session',session);link.searchParams.set('view',view==='terminal'?'terminal':'reader');frame.src=link.pathname+link.search;
    const panel={id,session,view:view==='terminal'?'terminal':'reader',box,frame,focus,ready:false};
    const controls=document.createElement('div');controls.className='split-panel-zoom';controls.setAttribute('role','group');controls.setAttribute('aria-label',qLangSplitWorkspace.t('이 패널 크기 조절'));
    const viewToggle=document.createElement('button');viewToggle.type='button';viewToggle.className='split-panel-view';viewToggle.addEventListener('click',()=>{this.focus(id);this.send(panel,{action:'view',view:panel.view==='reader'?'terminal':'reader'});});panel.viewButton=viewToggle;heading.append(viewToggle);
    const step=(region,direction)=>{this.focus(id);this.send(panel,{action:'zoom',region,direction});};
    for(const [direction,text,label] of [[-1,'−',qLangSplitWorkspace.t('이 패널 축소')],[1,'＋',qLangSplitWorkspace.t('이 패널 확대')]]){
      const button=document.createElement('button');button.type='button';button.textContent=text;button.className='split-panel-zoom-step';button.setAttribute('aria-label',label);button.title=label;button.addEventListener('click',()=>step(panel.view,direction));controls.append(button);
    }
    panel.zoomControls={values:{reader:1,terminal:1,sidebar:1,composer:1},step};
    panel.zoomMenu=this.zoomMenu(controls,panel.zoomControls);controls.insertBefore(panel.zoomMenu,controls.children[1]);
    const detach=document.createElement('button');detach.type='button';detach.className='split-panel-detach';detach.textContent=this.windows.auxiliary?qLangSplitWorkspace.t('돌려놓기 ↙'):qLangSplitWorkspace.t('창 분리 ↗');detach.title=this.windows.auxiliary?qLangSplitWorkspace.t('작업 공간으로 돌리기'):qLangSplitWorkspace.t('이 작업 화면을 별도 창으로 이동');detach.addEventListener('click',()=>this.windows.auxiliary?this.windows.returnToSource():this.windows.detach(id));
    heading.append(controls,detach,close);box.append(heading,frame);this.canvas.append(box);this.panels.set(id,panel);
    focus.title=qLangSplitWorkspace.t('제목을 끌어 작업 그룹 이동 · 창 밖으로 끌어 분리');focus.draggable=false;
    focus.addEventListener('pointerdown',event=>{if(this.windows.auxiliary||event.button!==0)return;event.preventDefault();this.mouse={session:panel.session,panel:id,x:event.clientX,y:event.clientY};focus.setPointerCapture(event.pointerId);});
    // Updating labels on pointerdown makes iOS cancel the following button click.
    // Let controls finish their click before changing the active panel.
    box.addEventListener('pointerdown',event=>{if(!event.target.closest('button,summary,input,select,a')&&this.active!==id)this.focus(id);});
    box.addEventListener('click',()=>{if(this.active!==id&&this.panels.has(id))this.focus(id);});
    return id;
  }
  select(session,view){
    if(!this.sessions().some(item=>item.id===session))return;
    if(!this.tree){if(this.windows.focusSession(session))return;return this.open(session,view);}
    const existing=[...this.panels.values()].find(panel=>panel.id===this.active&&panel.session===session)||[...this.panels.values()].find(panel=>panel.session===session);
    if(existing){this.focus(existing.id);if(view)this.send(existing,{action:'view',view});this.show();return;}
    if(this.windows.focusSession(session))return;
    const panel=this.panels.get(this.active);if(!panel)return;
    panel.session=session;if(view)panel.view=view;
    this.send(panel,{action:'select',session,view});this.show();this.update();this.save();
  }
  target(session,pane){this.select(session,'reader');const panel=this.panels.get(this.active);if(panel)this.send(panel,{action:'pane',pane});}
  send(panel,message){if(panel.ready)panel.frame.contentWindow.postMessage({tmuxSplit:true,...message},location.origin);else if(message.action!=='visible')(panel.queued??=[]).push(message);}
  message(event){
    if(event.origin!==location.origin||!event.data?.tmuxPanel)return;
    const panel=[...this.panels.values()].find(item=>item.frame.contentWindow===event.source);if(!panel)return;
    const message=event.data;
    if(message.action==='ready'){panel.ready=true;for(const queued of panel.queued||[])this.send(panel,queued);panel.queued=null;this.send(panel,{action:'visible',visible:this.visible&&!panel.box.hidden});this.windows.panelReady(panel);}
    if(message.action==='edited')this.windows.changed();
    if(message.action==='focus')this.focus(panel.id);
    if(message.action==='state'){
      if(this.sessions().some(item=>item.id===message.session))panel.session=message.session;
      if(['reader','terminal'].includes(message.view))panel.view=message.view;if(typeof message.pane==='string')panel.pane=message.pane;
      for(const region of ['reader','terminal','sidebar','composer'])if(Number.isFinite(message.zoom?.[region]))panel.zoomControls.values[region]=message.zoom[region];
      panel.zoomMenu.refresh();
      panel.dirty=message.dirty===true;this.update();this.save();this.windows.changed();
    }
    if(message.action==='login'){this.hide();document.dispatchEvent(new Event('tmux-login-expired'));}
    if(message.action==='manager')this.manager();
    if(message.action==='sidebarZoom'&&Number.isFinite(message.value)&&message.value>=.2&&message.value<=5)this.zoom(message.value);
    if(message.action==='notice')this.notice(String(message.text||''));
    if(message.action==='files')window.TmuxOpenFiles?.({host:message.host,path:message.path});
  }
  focus(id){if(!this.panels.has(id))return;this.active=id;this.menu.hidden=true;this.layout();this.update();this.save();}
  show(){this.visible=true;this.shell.hidden=false;document.documentElement.classList.add('split-workspace-open');document.getElementById('sessions-view').hidden=true;document.getElementById('task-view').hidden=true;for(const panel of this.panels.values())this.send(panel,{action:'visible',visible:true});this.update();this.viewport();}
  hide(){this.sidebarResizeEnd?.();this.visible=false;this.shell.hidden=true;document.documentElement.classList.remove('split-workspace-open');const header=document.querySelector('.app-header');for(const key of ['top','left','width'])header.style.removeProperty(key);this.cancelDrag();for(const panel of this.panels.values())this.send(panel,{action:'visible',visible:false});}
  reset(){this.hide();for(const panel of this.panels.values()){panel.zoomMenu.dispose();panel.box.remove();}this.panels.clear();this.tree=null;this.active='';}
  update(){
    if(!this.visible)return;
    const selected=this.panels.get(this.active)?.session;
    // Do not replace buttons during a hold/drag or destroy native sidebar scroll.
    const signature=JSON.stringify([this.sessions().map(item=>[item.id,this.label(item)]),this.hosts()]);
    if(this.list.dataset.signature!==signature&&!this.drag&&!this.touch&&!window.NavigationFolders?.dragging){
      this.list.replaceChildren();const groups=this.hosts().length?this.hosts():[{id:'',name:'Local',connected:true}];
      for(const host of groups){
        const group=ServerNavigation.group(host,()=>window.dispatchEvent(new Event('server-navigation-change')),this.connect,this.manageHost);this.list.append(group.section);
        for(const session of this.sessions().filter(item=>!host.id||item.host===host.id)){
          const button=document.createElement('button');button.type='button';button.className='split-session';button.dataset.session=session.id;button.textContent=this.label(session);button.title=this.hostLabel(session)+' / '+session.name;button.draggable=false;
          button.addEventListener('click',event=>{if(Date.now()<(this.suppressClick||0)){event.preventDefault();return;}if(event.shiftKey)this.showMenu(session.id);else this.select(session.id);});
          button.addEventListener('pointerdown',event=>{if(event.pointerType==='touch'||event.button!==0)return;this.mouse={session:session.id,x:event.clientX,y:event.clientY};button.setPointerCapture(event.pointerId);clearTimeout(this.mouseTimer);this.mouseTimer=setTimeout(()=>{if(this.mouse)this.beginDrag(session.id,false);},400);});
          button.addEventListener('touchstart',event=>{if(event.touches.length!==1)return;const t=event.touches[0];this.touch={session:session.id,x:t.clientX,y:t.clientY};clearTimeout(this.holdTimer);this.holdTimer=setTimeout(()=>{if(this.touch)this.beginDrag(session.id,true);},400);},{passive:true});
          button.addEventListener('contextmenu',event=>{event.preventDefault();this.manageSession(session);});group.items.append(ServerNavigation.row(session,button,this.manageSession));
        }
      }this.list.dataset.signature=signature;
    }
    for(const button of this.list.querySelectorAll('.split-session'))button.setAttribute('aria-current',String(button.dataset.session===selected));
    for(const panel of this.panels.values()){
      const session=this.sessions().find(item=>item.id===panel.session);panel.focus.textContent=session?this.hostLabel(session)+' · '+this.label(session):qLangSplitWorkspace.t('종료된 작업');panel.box.classList.toggle('is-active',panel.id===this.active);panel.box.querySelector('.split-panel-close').hidden=this.panels.size===1;
      ServerNavigation.paint(panel.box,session?.host);
      panel.viewButton.textContent=panel.view==='reader'?qLangSplitWorkspace.t('원본 보기'):qLangSplitWorkspace.t('작업 보기');panel.viewButton.setAttribute('aria-label',panel.view==='reader'?qLangSplitWorkspace.t('원본 보기로 전환'):qLangSplitWorkspace.t('작업 보기로 전환'));
    }
    this.windows.render();
  }
  save(){
    if(this.windows.auxiliary)return;
    const serialize=node=>{if(!node)return null;if(node.panel){const panel=this.panels.get(node.panel);return {session:panel.session,view:panel.view,pane:panel.pane};}return {axis:node.axis,ratio:node.ratio,first:serialize(node.first),second:serialize(node.second)};};
    try{localStorage.setItem('tmux-split-layout-v1',JSON.stringify({tree:serialize(this.tree),active:this.leaves().indexOf(this.active),detached:this.windows.descriptors()}));}catch{}
  }
  close(id){
    const panel=this.panels.get(id);if(!panel||this.panels.size===1)return;
    if(panel.dirty&&!confirm(qLangSplitWorkspace.t('이 창에 보내지 않은 내용이 있어요. 창을 닫을까요?')))return;
    const remove=node=>node.panel?node.panel===id?null:node:(()=>{const first=remove(node.first),second=remove(node.second);return first&&second?{...node,first,second}:first||second;})();
    this.tree=remove(this.tree);panel.zoomMenu.dispose();panel.box.remove();this.panels.delete(id);if(this.active===id)this.active=this.leaves()[0]||'';this.layout();this.update();this.save();
  }
  layout(){
    if(!this.visible)return;this.windows.renderEmpty();if(!this.tree)return;
    this.fitSidebar();
    const width=this.stage.clientWidth,height=this.stage.clientHeight;if(!width||!height)return;
    const min=this.minimum(this.tree);this.compact=this.panels.size>1&&(min.w>width||min.h>height);
    this.shell.classList.toggle('split-compact',this.compact);this.shell.querySelector('.split-add').title=this.compact?qLangSplitWorkspace.t('화면이 넓어지면 분할 배치를 복원해요.'):qLangSplitWorkspace.t('선택한 작업을 분할 창에 추가');
    this.rects=new Map();for(const divider of this.canvas.querySelectorAll('.split-divider'))divider.remove();
    const place=(id,rect)=>{this.rects.set(id,rect);const panel=this.panels.get(id);panel.box.hidden=false;Object.assign(panel.box.style,{left:rect.x+'px',top:rect.y+'px',width:rect.w+'px',height:rect.h+'px'});};
    if(this.compact){for(const panel of this.panels.values())panel.box.hidden=panel.id!==this.active;place(this.active,{x:0,y:0,w:width,h:height});}
    else {
      const walk=(node,rect)=>{
        if(node.panel){place(node.panel,rect);return;}
        const a=this.minimum(node.first),b=this.minimum(node.second),horizontal=node.axis==='x',available=(horizontal?rect.w:rect.h)-6;
        const first=Math.max(horizontal?a.w:a.h,Math.min(available-(horizontal?b.w:b.h),available*node.ratio));node.ratio=first/available;
        walk(node.first,{...rect,[horizontal?'w':'h']:first});
        walk(node.second,{...rect,[horizontal?'x':'y']:(horizontal?rect.x:rect.y)+first+6,[horizontal?'w':'h']:available-first});
        const divider=document.createElement('div');divider.className='split-divider '+(horizontal?'split-divider-x':'split-divider-y');divider.tabIndex=0;divider.setAttribute('role','separator');divider.setAttribute('aria-orientation',horizontal?'vertical':'horizontal');divider.setAttribute('aria-label',qLangSplitWorkspace.t('분할 창 크기 조절'));divider.setAttribute('aria-valuenow',String(Math.round(node.ratio*100)));
        Object.assign(divider.style,{left:(rect.x+(horizontal?first:0))+'px',top:(rect.y+(horizontal?0:first))+'px',width:(horizontal?6:rect.w)+'px',height:(horizontal?rect.h:6)+'px'});
        divider.addEventListener('pointerdown',event=>this.resizeStart(event,node,rect,a,b));
        divider.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();node.ratio+=['ArrowLeft','ArrowUp'].includes(event.key)?-.03:.03;this.layout();this.save();});this.canvas.append(divider);
      };walk(this.tree,{x:0,y:0,w:width,h:height});
    }
    for(const panel of this.panels.values())this.send(panel,{action:'visible',visible:this.visible&&!panel.box.hidden});
  }
  resizeStart(event,node,rect,a,b){
    event.preventDefault();const horizontal=node.axis==='x',start=horizontal?event.clientX:event.clientY,available=(horizontal?rect.w:rect.h)-6,initial=node.ratio*available;
    this.layer.hidden=false;this.layer.classList.add('is-resizing');this.preview.hidden=true;this.dropLabel.textContent='';
    const move=event=>{const delta=(horizontal?event.clientX:event.clientY)-start;node.ratio=Math.max(horizontal?a.w:a.h,Math.min(available-(horizontal?b.w:b.h),initial+delta))/available;this.layout();};
    const finish=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',finish);this.layer.hidden=true;this.layer.classList.remove('is-resizing');this.preview.hidden=false;this.save();};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish);window.addEventListener('pointercancel',finish);
  }
  beginDrag(session,touch){
    if(!this.tree)return;this.menu.hidden=true;this.drag={session,touch};this.suppressClick=Date.now()+1000;this.layer.hidden=false;this.preview.hidden=true;this.dropLabel.textContent=qLangSplitWorkspace.t('폴더로 이동 · 가장자리로 분할 · 창 밖으로 분리');this.shell.classList.add('split-dragging');
  }
  touchMove(event){
    const t=event.touches[0];if(!t)return;
    if(this.drag?.touch){event.preventDefault();this.point(t.clientX,t.clientY);return;}
    if(this.touch&&Math.hypot(t.clientX-this.touch.x,t.clientY-this.touch.y)>8){clearTimeout(this.holdTimer);this.touch=null;}
  }
  point(x,y){
    const folderDrop=window.NavigationFolders?.dropTarget(this.sessions().find(item=>item.id===this.drag?.session),x,y,this.sidebar);
    if(folderDrop){this.drop=folderDrop;this.preview.hidden=true;this.dropLabel.textContent=folderDrop.label;return;}
    const stage=this.stage.getBoundingClientRect();x-=stage.left;y-=stage.top;this.drop=null;this.preview.hidden=true;
    for(const [id,rect] of this.rects){
      if(this.drag?.panel===id)continue;
      if(x<rect.x||y<rect.y||x>rect.x+rect.w||y>rect.y+rect.h)continue;
      const edges=[['left',(x-rect.x)/rect.w],['right',(rect.x+rect.w-x)/rect.w],['top',(y-rect.y)/rect.h],['bottom',(rect.y+rect.h-y)/rect.h]].sort((a,b)=>a[1]-b[1]);
      if(edges[0][1]>.3){this.dropLabel.textContent=qLangSplitWorkspace.t('상하좌우 가장자리로 옮겨 주세요');return;}
      const edge=edges[0][0],horizontal=['left','right'].includes(edge),valid=this.canSplit(rect,edge);
      this.drop={id,edge,valid};this.preview.hidden=false;this.preview.classList.toggle('is-blocked',!valid);
      Object.assign(this.preview.style,{left:(stage.left+(rect.x)+(edge==='right'?rect.w/2:0))+'px',top:(stage.top+rect.y+(edge==='bottom'?rect.h/2:0))+'px',width:(horizontal?rect.w/2:rect.w)+'px',height:(horizontal?rect.h:rect.h/2)+'px'});
      this.dropLabel.textContent=valid?({left:qLangSplitWorkspace.t('왼쪽'),right:qLangSplitWorkspace.t('오른쪽'),top:qLangSplitWorkspace.t('위쪽'),bottom:qLangSplitWorkspace.t('아래쪽')}[edge]+qLangSplitWorkspace.t('에 분할 창 추가')):qLangSplitWorkspace.t('창이 너무 작아져요. 화면을 넓히거나 다른 창에 놓아 주세요');return;
    }
  }
  canSplit(rect,edge){const min=this.panelMinimum();return !this.windows.auxiliary&&!this.compact&&(['left','right'].includes(edge)?rect.w>=min.w*2+6&&rect.h>=min.h:rect.h>=min.h*2+6&&rect.w>=min.w);}
  split(session,id,edge){
    const rect=this.rects.get(id);if(!rect||!this.canSplit(rect,edge)){this.notice(qLangSplitWorkspace.t('창이 너무 작아져 분할할 수 없어요. 화면을 넓히거나 다른 창에 놓아 주세요.'));return false;}
    const added=this.create(session),first=['left','top'].includes(edge),replace=node=>node.panel?node.panel===id?{axis:['left','right'].includes(edge)?'x':'y',ratio:.5,first:first?{panel:added}:node,second:first?node:{panel:added}}:node:{...node,first:replace(node.first),second:replace(node.second)};
    this.tree=replace(this.tree);this.active=added;this.layout();this.update();this.save();return true;
  }
  finishDrag(){const drag=this.drag,drop=this.drop;this.cancelDrag();if(drag&&drop){if(drop.kind==='folder'){if(!drop.valid)this.notice(drop.label);else try{if(NavigationFolders.drop(this.sessions().find(item=>item.id===drag.session),drop))this.notice(drop.label+qLangSplitWorkspace.t('했어요.'));}catch{this.notice(qLangSplitWorkspace.t('폴더 정리를 저장하지 못했어요. 다시 시도해 주세요.'));}return;}if(drop.valid){if(drag.panel)this.windows.moveGroup(drag.panel,drop.id,drop.edge);else this.split(drag.session,drop.id,drop.edge);}else this.notice(qLangSplitWorkspace.t('창이 너무 작아져 분할할 수 없어요.'));}}
  cancelDrag(){window.NavigationFolders?.clearDrop();this.drag=null;this.drop=null;clearTimeout(this.holdTimer);this.layer.hidden=true;this.preview.hidden=false;this.shell.classList.remove('split-dragging');this.suppressClick=Date.now()+350;}
  showMenu(session){
    this.menu.replaceChildren();const label=document.createElement('label');label.textContent=qLangSplitWorkspace.t('추가할 작업');const select=document.createElement('select');select.setAttribute('aria-label',qLangSplitWorkspace.t('새 창에 추가할 작업'));for(const item of this.sessions())select.add(new Option(this.hostLabel(item)+' · '+this.label(item),item.id));select.value=session||this.panels.get(this.active)?.session;label.append(select);this.menu.append(label);
    const group=document.createElement('div');for(const [edge,text] of [['left',qLangSplitWorkspace.t('왼쪽')],['right',qLangSplitWorkspace.t('오른쪽')],['top',qLangSplitWorkspace.t('위쪽')],['bottom',qLangSplitWorkspace.t('아래쪽')]]){const button=document.createElement('button');button.type='button';button.textContent=text;button.disabled=!this.canSplit(this.rects.get(this.active)||{w:0,h:0},edge);button.addEventListener('click',()=>{this.menu.hidden=true;this.split(select.value,this.active,edge);});group.append(button);}this.menu.append(group);
    const detach=document.createElement('button');detach.type='button';detach.className='split-menu-detach';detach.textContent=qLangSplitWorkspace.t('별도 창에서 열기 ↗');detach.addEventListener('click',()=>{this.menu.hidden=true;this.windows.openSession(select.value);});this.menu.append(detach);
    const hint=document.createElement('p');hint.textContent=qLangSplitWorkspace.t('분할하거나 별도 창에서 작업할 수 있어요.');this.menu.append(hint);this.menu.hidden=!this.menu.hidden;
  }
}
