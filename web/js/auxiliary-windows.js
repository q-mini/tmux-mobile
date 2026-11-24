const qLangAuxiliaryWindows=globalThis.QI18n||{t:value=>value,html:value=>value,f:(key,values)=>key.replace(/\{(\d+)\}/g,(_,index)=>String(values[index]??'')),locale:'ko-KR'};
'use strict';

// Real top-level windows own their editor; the source frame is kept alive only
// as a recovery copy. No iframe is reparented and no draft/File enters storage.
class TmuxAuxiliaryWindows {
  constructor(workspace){
    this.workspace=workspace;this.records=new Map();this.retired=new Set();const query=new URLSearchParams(location.search);
    this.key=query.get('auxiliary')||'';this.auxiliary=!!this.key;this.owner=query.get('owner')||'';this.rejoin=query.get('rejoin')||'';
    let id;try{id=sessionStorage.getItem('tmux-workspace-window-id');}catch{}
    this.id=this.rejoin&&this.owner?this.owner:id||crypto.randomUUID();
    if(!this.auxiliary){try{sessionStorage.setItem('tmux-workspace-window-id',this.id);}catch{}window.TmuxAuxiliaryHost=this;}
    this.list=document.createElement('nav');this.list.className='split-detached-list';this.list.setAttribute('aria-label',qLangAuxiliaryWindows.t('분리된 창'));workspace.list.before(this.list);
    this.empty=document.createElement('div');this.empty.className='split-empty';this.empty.hidden=true;
    const text=document.createElement('p');text.textContent=qLangAuxiliaryWindows.t('작업 화면이 별도 창에 열려 있어요.');const button=document.createElement('button');button.type='button';button.textContent=qLangAuxiliaryWindows.t('다른 작업 열기');button.addEventListener('click',()=>workspace.manager());this.empty.append(text,button);workspace.stage.append(this.empty);
    workspace.shell.classList.toggle('is-auxiliary',this.auxiliary);
    if(this.auxiliary)workspace.shell.querySelector('.split-help').textContent=qLangAuxiliaryWindows.t('독립 작업 창');
    window.addEventListener('message',event=>this.message(event));
    window.addEventListener('pagehide',()=>{if(this.auxiliary)this.publishClosing();});
    window.addEventListener('beforeunload',()=>{if(this.auxiliary)this.publishClosing();});
    this.timer=setInterval(()=>{
      if(this.auxiliary){this.changed();this.render();return;}
      for(const record of [...this.records.values()]){
        if(record.popup?.closed){if(record.committed)this.returnRecord(record.key);else this.cancel(record);}
        else if(record.popup&&!record.committed&&Date.now()-record.started>30000){this.cancel(record);workspace.notice(qLangAuxiliaryWindows.t('별도 창을 열지 못했어요. 창 분리를 다시 눌러 주세요.'));}
      }
    },400);
  }
  frame(panel){return panel?.frame.contentWindow?.TmuxPanelState;}
  current(){return this.workspace.panels.get(this.workspace.active)||this.workspace.panels.values().next().value;}
  export(){const state=this.frame(this.current())?.export();return state&&!state.busy?state:null;}
  post(action,extra={}){try{if(window.opener&&!window.opener.closed)window.opener.postMessage({tmuxAux:true,key:this.key,owner:this.owner,action,...extra},location.origin);}catch{}}
  panelReady(){if(this.auxiliary)this.post('ready');}
  changed(){if(this.auxiliary&&this.current()?.ready)this.post('changed');}
  publishClosing(){try{const state=this.export();if(state&&window.opener&&!window.opener.closed)window.opener.TmuxAuxiliaryHost?.closing(this.key,state,window);}catch{}}
  closing(key,state,popup){const record=this.records.get(key);if(record?.popup===popup&&record.committed)record.snapshot=state;}
  descriptors(){return [...this.records.values()].filter(record=>record.committed).map(record=>({key:record.key,owner:this.id,session:record.snapshot?.session||record.session,view:record.snapshot?.view||record.view}));}
  restore(saved){if(this.auxiliary)return;for(const data of saved?.detached||[]){if(data.owner===this.id&&typeof data.key==='string')this.records.set(data.key,{...data,committed:true,popup:null});}}
  validSource(event){
    try{if(event.source.closed)return false;const query=new URL(event.source.location.href).searchParams;return event.source.opener===window&&query.get('auxiliary')===event.data.key&&query.get('owner')===this.id;}catch{return false;}
  }
  message(event){
    const data=event.data;if(event.origin!==location.origin||!data?.tmuxAux)return;
    if(this.auxiliary){
      if(event.source!==window.opener||data.key!==this.key||data.owner!==this.owner)return;
      if(data.action==='import'){
        try{const panel=this.current();if(!panel?.ready)return;this.frame(panel).import(data.snapshot);this.post('imported');this.changed();}
        catch(error){this.post('failed',{text:error.message});}
      }
      return;
    }
    if(data.owner!==this.id||this.retired.has(data.key)||!this.validSource(event))return;
    let record=this.records.get(data.key);
    if(!record){const snapshot=event.source.TmuxAuxiliaryHostState?.export();if(!snapshot)return;record={key:data.key,session:snapshot.session,view:snapshot.view,snapshot,popup:event.source,committed:true};this.records.set(data.key,record);}
    if(record.popup&&record.popup!==event.source)return;record.popup=event.source;
    if(data.action==='ready'){
      try{
        if(!record.committed){const state=this.frame(record.panel)?.export();if(!state||state.busy)throw new Error(qLangAuxiliaryWindows.t('전송이 끝난 뒤 창을 분리해 주세요.'));record.snapshot=state;record.panel.frame.inert=true;this.workspace.send(record.panel,{action:'visible',visible:false});}
        if(record.snapshot)record.popup.postMessage({tmuxAux:true,key:record.key,owner:this.id,action:'import',snapshot:record.snapshot},location.origin);
      }catch(error){this.cancel(record);this.workspace.notice(error.message);}
    }
    if(data.action==='imported'&&!record.committed){
      const w=this.workspace;record.committed=true;record.tree=w.tree;record.siblings=w.leaves().filter(id=>id!==record.panel.id);record.anchor=record.siblings[0];
      w.tree=this.remove(w.tree,record.panel.id);w.panels.delete(record.panel.id);record.panel.box.hidden=true;if(w.active===record.panel.id)w.active=w.leaves()[0]||'';
      w.layout();w.update();w.save();
    }
    if(data.action==='changed'||data.action==='imported'){
      const snapshot=record.popup.TmuxAuxiliaryHostState?.export();if(snapshot){record.snapshot=snapshot;record.session=snapshot.session;record.view=snapshot.view;}
      this.render();this.workspace.save();if(this.rejoin===record.key&&record.committed){this.rejoin='';this.returnRecord(record.key);}
    }
    if(data.action==='failed'){this.cancel(record);this.workspace.notice(data.text||qLangAuxiliaryWindows.t('창을 분리하지 못했어요.'));}
  }
  remove(node,id){if(!node)return null;if(node.panel)return node.panel===id?null:node;const first=this.remove(node.first,id),second=this.remove(node.second,id);return first&&second?{...node,first,second}:first||second;}
  insert(node,id,target,edge='right'){
    if(!node)return {panel:id};if(node.panel){if(node.panel!==target)return node;const added={panel:id},before=['left','top'].includes(edge);return {axis:['left','right'].includes(edge)?'x':'y',ratio:.5,first:before?added:node,second:before?node:added};}
    return {...node,first:this.insert(node.first,id,target,edge),second:this.insert(node.second,id,target,edge)};
  }
  moveGroup(id,target,edge){const w=this.workspace;if(id===target||!w.panels.has(id)||!w.panels.has(target))return;w.tree=this.insert(this.remove(w.tree,id),id,target,edge);w.focus(id);}
  detach(id){
    if(this.auxiliary)return;const w=this.workspace,panel=w.panels.get(id);if(!panel?.ready)return;
    const existing=[...this.records.values()].find(record=>record.panel===panel);if(existing){existing.popup?.focus();return;}
    const snapshot=this.frame(panel)?.export();if(!snapshot||snapshot.busy){w.notice(qLangAuxiliaryWindows.t('전송이 끝난 뒤 창을 분리해 주세요.'));return;}
    const key=crypto.randomUUID(),url=new URL(location.pathname,location.origin);url.search=new URLSearchParams({auxiliary:key,owner:this.id,session:snapshot.session,view:'reader'});
    const width=Math.min(1000,screen.availWidth||1000),height=Math.min(850,screen.availHeight||850),offset=this.records.size*32;
    const popup=window.open(url.pathname+url.search,'q-tmux-'+key,`popup=yes,resizable=yes,scrollbars=no,width=${width},height=${height},left=${Math.max(0,screenX+60+offset)},top=${Math.max(0,screenY+60+offset)}`);
    if(!popup){w.notice(qLangAuxiliaryWindows.t('브라우저에서 이 사이트의 팝업을 허용한 뒤 창 분리를 다시 눌러 주세요.'));return;}
    this.records.set(key,{key,panel,snapshot,popup,session:panel.session,view:panel.view,started:Date.now(),committed:false});this.render();popup.focus();
  }
  openSession(session){
    if(this.focusSession(session))return;const w=this.workspace;
    // The user selects this action directly, so window.open retains activation.
    const key=crypto.randomUUID(),url=new URL(location.pathname,location.origin);url.search=new URLSearchParams({auxiliary:key,owner:this.id,session,view:'reader'});
    const popup=window.open(url.pathname+url.search,'q-tmux-'+key,'popup=yes,resizable=yes,width=1000,height=800');
    if(!popup){w.notice(qLangAuxiliaryWindows.t('브라우저에서 이 사이트의 팝업을 허용해 주세요.'));return;}
    this.records.set(key,{key,session,view:'reader',popup,started:Date.now(),committed:true});this.render();
  }
  cancel(record){
    if(record.committed)return;this.retired.add(record.key);this.records.delete(record.key);if(record.panel){record.panel.frame.inert=false;this.workspace.send(record.panel,{action:'visible',visible:true});}record.popup?.close();this.render();
  }
  returnRecord(key){
    const record=this.records.get(key);if(!record?.committed)return false;const w=this.workspace;
    if(record.returning)return true;
    let state=record.snapshot;try{if(record.popup&&!record.popup.closed){const live=record.popup.TmuxAuxiliaryHostState?.export();if(!live){w.notice(qLangAuxiliaryWindows.t('전송이 끝난 뒤 작업 공간으로 돌려 주세요.'));return false;}state=live;record.popup.TmuxAuxiliaryHostState?.pause();}}catch{}
    if(!state){w.notice(qLangAuxiliaryWindows.t('분리된 창에서 돌아오기를 눌러 주세요.'));return false;}
    let panel=record.panel;
    if(!panel){const id=w.create(state.session,state.view);panel=w.panels.get(id);record.panel=panel;}
    const apply=()=>{
      try{this.frame(panel).import(state);}catch(error){w.notice(error.message);return false;}
      w.panels.set(panel.id,panel);panel.frame.inert=false;panel.box.hidden=false;
      const remaining=w.leaves(),same=record.tree&&remaining.length===record.siblings?.length&&record.siblings.every(id=>remaining.includes(id));
      w.tree=same?record.tree:this.insert(w.tree,panel.id,w.panels.has(record.anchor)?record.anchor:remaining[0]);w.active=panel.id;
      this.retired.add(key);this.records.delete(key);w.show();w.layout();w.update();w.save();record.popup?.close();window.focus();return true;
    };
    if(panel.ready)return apply();record.returning=true;const pending=setInterval(()=>{if(panel.ready){clearInterval(pending);apply();}},50);return true;
  }
  returnToSource(){
    try{if(window.opener&&!window.opener.closed&&window.opener.TmuxAuxiliaryHost?.returnRecord(this.key))return;}catch{}
    if(window.opener&&!window.opener.closed){this.workspace.notice(qLangAuxiliaryWindows.t('원래 작업 공간의 연결을 확인하고 있어요. 잠시 뒤 다시 눌러 주세요.'));return;}
    const state=this.export();if(!state)return;const url=new URL(location.pathname,location.origin);url.search=new URLSearchParams({session:state.session,rejoin:this.key,owner:this.owner});
    const source=window.open(url.pathname+url.search,'q-tmux-workspace-'+this.owner);if(source){window.opener=source;this.post('changed');}
  }
  focusSession(session){if(this.auxiliary)return false;const record=[...this.records.values()].find(item=>item.committed&&item.session===session&&item.popup&&!item.popup.closed);if(!record)return false;record.popup.focus();return true;}
  renderEmpty(){this.empty.hidden=!!this.workspace.tree||!this.records.size;}
  render(){
    this.renderEmpty();this.list.hidden=this.auxiliary||!this.records.size;if(this.auxiliary){
      window.TmuxAuxiliaryHostState={export:()=>this.export(),pause:()=>{const panel=this.current();if(panel)this.workspace.send(panel,{action:'visible',visible:false});}};
      const panel=this.current();if(panel)document.title=panel.focus.textContent+' · Q tmux';return;
    }
    const signature=JSON.stringify([...this.records.values()].map(record=>[record.key,record.session,record.committed]));if(this.list.dataset.signature===signature)return;this.list.dataset.signature=signature;this.list.replaceChildren();
    for(const record of this.records.values()){
      const row=document.createElement('div'),session=this.workspace.sessions().find(item=>item.id===record.session),focus=document.createElement('button');focus.type='button';focus.textContent=(session?this.workspace.label(session):qLangAuxiliaryWindows.t('분리된 창'))+' ↗';focus.title=qLangAuxiliaryWindows.t('분리된 창 앞으로');focus.addEventListener('click',()=>{if(record.popup&&!record.popup.closed)record.popup.focus();else this.workspace.notice(qLangAuxiliaryWindows.t('분리된 창을 다시 연결하고 있어요.'));});
      const back=document.createElement('button');back.type='button';back.textContent='↙';back.title=qLangAuxiliaryWindows.t('작업 공간으로 돌리기');back.setAttribute('aria-label',back.title);back.addEventListener('click',()=>this.returnRecord(record.key));row.append(focus,back);this.list.append(row);
    }
  }
}
