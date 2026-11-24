'use strict';
const qLangWorkspace=globalThis.QI18n||{t:value=>value,html:value=>value,f:(key,values)=>key.replace(/\{(\d+)\}/g,(_,index)=>String(values[index]??'')),locale:'ko-KR'};
const $=id=>document.getElementById(id);
const element=(tag,text,className='')=>{const node=document.createElement(tag);node.textContent=text;node.className=className;return node;};
const panelClient=new URLSearchParams(location.search).get('panel')==='1';
const fileViewClient=new URLSearchParams(location.search).get('file-view')==='1';
document.documentElement.classList.toggle('tmux-panel',panelClient);
let panelVisible=!panelClient||parent===window,panelReady=false,lastPanelState='',panelSessionMissing=false;
const panelMessage=message=>{if(panelClient&&parent!==window)parent.postMessage({tmuxPanel:true,...message},location.origin);};
function stored(name,fallback){try{return JSON.parse(localStorage.getItem(name))??fallback;}catch{return fallback;}}
let pins=stored('tmux-pins',[]),aliases=stored('tmux-aliases',{});
if(!Array.isArray(pins))pins=[];if(!aliases||typeof aliases!=='object'||Array.isArray(aliases))aliases={};
let inventory=[],hosts=[],sessionId='',paneId='',mode='reader',readerVersion='',readerText='',readerGeneration=0;
let sessionTimer,readerTimer,noticeTimer,socket,reconnectTimer,terminal,terminalReady=false,ctrl=false;
let startupTimer,startupAttempt=0,startupGeneration=0;
let follow=true,pending=false,requestRunning=false,reconnectAttempt=0;
let terminalFrame=0,terminalExpanded=false,fullscreenScroll=0;
let readerExpanded=false,readerFullscreenScroll=0,readerAutoLoads=0;
let viewZoom,readerZooming=false,panelRestoring=false;
let composerCollapsed=stored('tmux-composer-collapsed',false)===true;
let composerHeight=null,composerResizeEnd=null;
const composerHeights=stored('tmux-composer-heights',{});
let terminalGeneration=0,terminalFontPromise;
let pendingReader=null,historyLoading=false,readerMore=false,readerRenderedAnsi=null,readerMessages=null;
const readerHistory=new Map();
const conversationReader=new ConversationReader(api);
const questionPanel=new QuestionPanel({area:$('reader-interaction'),fetch:api,send:sendPane,notice,context:()=>conversationReader.state(false).messages,changed:()=>{if(mode==='reader'&&paneId)startReader();}});
const agentControls=new AgentControls({form:$('compose-form'),input:$('message'),fetch:api,send:sendPane,notice,changed:()=>{if(mode==='reader'&&paneId)startReader();}});
const deliveryPanel=new PendingDelivery({form:$('compose-form'),fetch:api,send:sendPane,notice,changed:pending=>{if([qLangWorkspace.t('보냄'),qLangWorkspace.t('전달 대기')].includes($('send-state').textContent))$('send-state').textContent=pending?qLangWorkspace.t('전달 대기'):qLangWorkspace.t('보냄');}});
const notificationCenter=new TmuxNotifications({api,notice,openTarget:async item=>{
  await refreshSessions();const session=inventory.find(session=>session.id===item.session_id&&session.host===item.host);
  if(!session||!session.panes.some(pane=>pane.id===item.pane_id))throw new Error(qLangWorkspace.t('이 알림의 작업 화면이 종료됐어요.'));
  if(splitWorkspace){splitWorkspace.target(session.id,item.pane_id);return;}
  const expanded=readerExpanded||terminalExpanded;setMode('reader');switchSession(session.id);choosePane(item.pane_id);if(expanded)setReaderExpanded(true);
}});
let setupHost='',setupPending=false;
const splitWorkspace=panelClient||fileViewClient?null:new TmuxSplitWorkspace({sessions:()=>inventory,hosts:()=>hosts,label:session=>sessionName(session),hostLabel:session=>hostName(session),manager:()=>showManager(),notice:text=>notice(text),connect:host=>openHostSetup(host),manageHost:host=>openServerEditor(host),addHost:()=>openServerEditor(),manageSession:session=>openSessionManager(session),zoom:value=>viewZoom?.set('sidebar',value),zoomMenu:(host,controls)=>viewZoom.mount(host,controls)});
function fileContext(){const panel=splitWorkspace?.panels.get(splitWorkspace.active),session=inventory.find(s=>s.id===(panel?.session||sessionId)),pane=session?.panes.find(p=>p.id===(panel?.pane||paneId))||session?.panes.find(p=>p.active)||session?.panes[0];return {host:session?.host,path:pane?.path||session?.path||''};}
window.TmuxFiles=panelClient&&parent!==window?null:new TmuxFileBrowser({hosts:()=>hosts,context:fileContext,api,notice});
if(window.TmuxFiles)window.TmuxFiles.currentHost=()=>window.TmuxFiles.host||fileContext().host||hosts[0]?.id;
window.TmuxOpenFiles=options=>{const target=options||fileContext();if(window.TmuxFiles)window.TmuxFiles.open(target);else panelMessage({action:'files',...target});};
document.getElementById('open-files').onclick=()=>window.TmuxOpenFiles(fileContext());
const drafts=new Map();
const attachmentDrafts=new Map(),sendIntents=new Map();
const MAX_FILE_SIZE=50*1024*1024;
const queuedAttachments=target=>attachmentDrafts.get(target)||[];
function renderAttachments(){
  const files=queuedAttachments(paneId);$('attachment-list').replaceChildren();$('attachment-list').hidden=!files.length;
  for(const entry of files){
    const chip=element('div','','attachment-chip');chip.title=entry.file.name;
    chip.append(element('span',entry.file.name),element('small',entry.uploaded?qLangWorkspace.t('준비됨'):entry.file.size>=1024*1024?(entry.file.size/1024/1024).toFixed(1)+' MB':Math.max(1,Math.ceil(entry.file.size/1024))+' KB'));
    const remove=element('button','×');remove.type='button';remove.disabled=pending;remove.setAttribute('aria-label',entry.file.name+qLangWorkspace.t(' 첨부 제거'));
    remove.addEventListener('click',()=>{attachmentDrafts.set(paneId,queuedAttachments(paneId).filter(item=>item!==entry));if(entry.uploaded)api('/api/attachments/'+entry.uploaded.id,{method:'DELETE'}).catch(()=>notice(qLangWorkspace.t('남은 임시 파일은 자동 정리돼요.')));renderAttachments();});chip.append(remove);$('attachment-list').append(chip);
  }
  $('attach-files').disabled=pending||!paneId;scheduleTerminalFit();
  publishPanelState();
}
function queueFiles(files){
  if(!paneId||pending){notice(pending?qLangWorkspace.t('전송이 끝난 뒤 첨부해 주세요.'):qLangWorkspace.t('먼저 작업 화면을 선택해 주세요.'));return;}
  const queued=[...queuedAttachments(paneId)];
  for(const file of files){if(file.size>MAX_FILE_SIZE){notice(file.name+qLangWorkspace.t(': 파일당 최대 50 MB까지 첨부할 수 있어요.'));continue;}queued.push({file,uploaded:null});}
  attachmentDrafts.set(paneId,queued);renderAttachments();
}
const keyData={escape:'\x1b',tab:'\t',up:'\x1b[A',down:'\x1b[B',left:'\x1b[D',right:'\x1b[C',enter:'\r',interrupt:'\x03'};
const directInput=new DirectInput({form:$('compose-form'),message:$('message'),send:sendPane,target:()=>paneId,notice,changed:()=>updateTerminalViewport()});
function openNewSession(target){
  const requested=typeof target==='string'?hosts.find(host=>host.id===target):null;
  if(requested&&!requested.connected){openHostSetup(requested);return;}
  const select=$('new-session-host');select.replaceChildren();for(const host of hosts){const option=new Option(host.name+(host.connected?'':' · '+qLangWorkspace.t(host.status)),host.id);option.disabled=!host.connected;select.add(option);}
  const current=requested?.id||selectedSession()?.host;if(current&&hosts.some(host=>host.id===current&&host.connected))select.value=current;
  $('new-session-status').textContent='';$('new-session-dialog').showModal();$('new-session-name').focus();
}
const selectedSession=()=>inventory.find(item=>item.id===sessionId);
const selectedPane=()=>selectedSession()?.panes.find(item=>item.id===paneId);
const sessionKey=session=>session.host_local===false?session.host+'~'+session.name:session.name;
const sessionName=session=>aliases[sessionKey(session)]||session.name;
const hostName=session=>session.host_name||'Local';
// iPadOS can identify as Macintosh, including when a trackpad is attached.
const phoneClient=()=>navigator.userAgentData?.mobile===true||/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
  ||navigator.maxTouchPoints>1&&/Mac/i.test(navigator.platform+' '+navigator.userAgent);
const desktopClient=()=>!phoneClient()&&(matchMedia('(hover: hover) and (pointer: fine)').matches||innerWidth>=900);
const desktopTerminal=()=>desktopClient();
const desktopTask=()=>desktopClient();
const terminalTouch=new TerminalTouch({area:$('terminal-scroll'),history:$('terminal-history'),fit:()=>fitTerminal(),mobile:phoneClient,notice,
  tap:point=>terminalTap(point),
  onZoom:value=>{if(viewZoom){terminalTouch.defaultZoom=value;viewZoom.rememberTerminal(value);}},
  load:(target,history)=>api(`/api/panes/${encodeURIComponent(target)}/snapshot?grid=1&history=${history}`)});
const paneName=pane=>pane.title&&pane.title!==pane.command?pane.title:pane.command||qLangWorkspace.f("화면 {0}",[pane.index+1]);
const shortPath=value=>(value||'').split('/').filter(Boolean).slice(-2).join('/');
function notice(text){text=qLangWorkspace.t(text);if(panelClient&&parent!==window){panelMessage({action:'notice',text:String(text)});return;}$('notice').textContent=text;$('notice').hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('notice').hidden=true,8000);}
function status(text,live=false){$('status-text').textContent=qLangWorkspace.t(text);$('status-light').classList.toggle('connected',live);}
async function api(path,options={}){
  const response=await fetch(path,{credentials:'same-origin',...options});
  if(!response.ok){const error=new Error(qLangWorkspace.t(await response.text()));error.status=response.status;if(response.status===401&&path!=='/api/login')showLogin();throw error;}
  return response.json();
}
function savePreferences(){localStorage.setItem('tmux-pins',JSON.stringify(pins));localStorage.setItem('tmux-aliases',JSON.stringify(aliases));}
function detachTerminal(){terminalGeneration++;clearTimeout(reconnectTimer);terminalReady=false;if(socket){socket.onclose=null;socket.close();socket=null;}}
function stopReader(){clearTimeout(readerTimer);readerGeneration++;}
function startup(visible){const view=$('startup-view');if(view)view.hidden=!visible;document.body.toggleAttribute('data-starting',visible);}
function showLogin(){clearTimeout(startupTimer);startup(false);window.TmuxFiles?.close(true);document.body.classList.remove('file-view-window');agentControls.select('');splitWorkspace?.reset();panelMessage({action:'login'});notificationCenter.stop();deliveryPanel.stop();$('host-dialog').close();$('host-password').value='';setTerminalExpanded(false);setReaderExpanded(false);if(paneId)drafts.set(paneId,$('message').value);clearTimeout(sessionTimer);stopReader();detachTerminal();sessionId='';paneId='';$('workspace').hidden=true;$('login-view').hidden=false;}
async function showWorkspace(options={}){
  const data=await api('/api/sessions',options);inventory=data.sessions;hosts=data.hosts||[];$('login-view').hidden=true;$('workspace').hidden=false;startup(false);
  if(fileViewClient){$('workspace').hidden=true;await TmuxFileLayout.start(window.TmuxFiles,new URLSearchParams(location.search));return;}
  renderSessions();status(qLangWorkspace.t('연결됨'),true);scheduleSessions();
  const link=new URLSearchParams(location.search),requested=link.get('session');
  const linked=inventory.find(item=>(item.id===requested||item.name===requested)&&(!link.get('server')||item.host===link.get('server')));
  if(splitWorkspace){splitWorkspace.start(linked?.id,link.get('view')||undefined);if(!splitWorkspace.visible)showManager();notificationCenter.start();return;}
  const remembered=localStorage.getItem('tmux-mobile-session');
  if(!sessionId&&linked){openSession(linked.id);if(link.get('view')==='terminal'){setMode('terminal');if(link.get('fullscreen')==='1')setTerminalExpanded(true);}else if(link.get('fullscreen')==='1')setReaderExpanded(true);}
  else if(!sessionId&&inventory.some(item=>item.id===remembered))openSession(remembered);else if(!sessionId)showManager();
  panelReady=true;panelMessage({action:'ready'});publishPanelState();
  deliveryPanel.start();
}
function scheduleSessions(){clearTimeout(sessionTimer);sessionTimer=setTimeout(async()=>{if(!$('workspace').hidden&&!document.hidden){try{await refreshSessions(false);}catch(error){if(error.status!==401)status(qLangWorkspace.t('연결 확인 중'));}}if(!$('workspace').hidden)scheduleSessions();},5000);}
async function refreshSessions(manual=false){
  const data=await api('/api/sessions'+(manual?'?refresh=1':''));inventory=data.sessions;hosts=data.hosts||[];renderSessions();
  if(sessionId&&!selectedSession()){if(panelClient){panelSessionMissing=true;$('send-message').disabled=true;status(qLangWorkspace.t('작업 연결을 확인하는 중'));return;}notice(qLangWorkspace.t('선택한 작업이 종료됐어요.'));showManager();}
  else if(sessionId){if(paneId&&!selectedPane()){stopReader();paneId='';$('reader-content').replaceChildren(element('p',qLangWorkspace.t('선택한 화면이 종료됐어요. 위에서 다른 화면을 골라 주세요.'),'empty'));}renderTask();if(mode==='terminal')resize();}
  if(panelSessionMissing&&selectedSession()){panelSessionMissing=false;if(mode==='reader')startReader();else connectTerminal();}
  if(!sessionId)status(qLangWorkspace.t('연결됨'),true);
}
function togglePin(session){const key=sessionKey(session);pins=pins.includes(key)?pins.filter(name=>name!==key):[...pins,key];savePreferences();renderSessions();if(sessionId)renderTask();}
function renderHosts(){
  const signature=JSON.stringify(hosts);if($('host-status').dataset.hosts===signature)return;
  $('host-status').replaceChildren();$('host-status').dataset.hosts=signature;
  for(const host of hosts){
    const button=element('button','',host.connected?'host-connected':'host-unavailable');button.type='button';button.dataset.host=host.id;button.title=host.address;
    ServerNavigation.paint(button,host.id);
    button.append(element('strong',host.name),element('span',host.connected?qLangWorkspace.f("작업 {0}개",[host.sessions]):qLangWorkspace.t(host.status)));
    button.addEventListener('click',()=>{if(!host.local&&!host.connected){openHostSetup(host);return;}$('session-search').value=host.id;showManager();renderSessions();});$('host-status').append(button);
  }
}
let hostTrustToken='',editingHost=null,managingSession=null;
function openServerEditor(host=null){
  editingHost=host;$('server-edit-title').textContent=host?qLangWorkspace.t('서버 설정'):qLangWorkspace.t('SSH 서버 추가');
  for(const [id,value] of [['server-name',host?.name||''],['server-address',host?.address||''],['server-user',host?.user||''],['server-port',host?.port||22],['server-platform',host?.platform||'linux']])$(id).value=value;
  const local=host?.local===true;$('server-edit-form').querySelector('.server-remote-fields').hidden=local;
  for(const id of ['server-address','server-port','server-user'])$(id).required=!local;
  $('server-remove').hidden=!host||local;$('server-edit-status').textContent='';serverPlatformHelp();$('server-edit-dialog').showModal();$('server-name').focus();
}
function serverPlatformHelp(){ $('server-platform-help').textContent={linux:qLangWorkspace.t('서버에 SSH·tmux·Python 3이 필요해요.'),macos:qLangWorkspace.t('Mac의 시스템 설정 → 일반 → 공유에서 원격 로그인을 켜고, tmux와 Python 3을 설치해 주세요. 같은 Mac도 SSH로 연결할 수 있어요.'),windows:qLangWorkspace.t('Windows OpenSSH 서버를 켜고 WSL의 기본 배포판에 tmux와 Python 3을 설치해 주세요. 사용자 이름은 Windows SSH 계정이며 작업은 그 계정의 기본 WSL에서 열려요.')}[$('server-platform').value]; }
$('server-platform').addEventListener('change',serverPlatformHelp);
$('add-server').addEventListener('click',()=>openServerEditor());
$('server-edit-form').addEventListener('submit',async event=>{event.preventDefault();const old=editingHost;const data={action:old?'edit':'add',id:old?.id,name:$('server-name').value.trim()};if(!old?.local)Object.assign(data,{address:$('server-address').value.trim(),port:Number($('server-port').value),user:$('server-user').value.trim(),platform:$('server-platform').value});$('server-save').disabled=true;try{const result=await api('/api/hosts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});await refreshSessions();$('server-edit-dialog').close();const host=hosts.find(h=>h.id===result.host);if(host&&!host.local&&!host.connected)openHostSetup(host);}catch(error){$('server-edit-status').textContent=error.message;}finally{$('server-save').disabled=false;}});
$('server-remove').addEventListener('click',async()=>{const host=editingHost;if(!host||!confirm(host.name+qLangWorkspace.t(' 서버를 목록에서 제거할까요? 서버의 세션과 파일은 유지돼요.')))return;try{await api('/api/hosts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'remove',id:host.id})});$('server-edit-dialog').close();await refreshSessions();}catch(error){$('server-edit-status').textContent=error.message;}});
function openSessionManager(session){managingSession=session;$('session-manage-title').textContent=sessionName(session);$('session-manage-host').textContent=hostName(session);$('session-new-name').value=session.name;$('session-manage-status').textContent='';$('session-manage-dialog').showModal();}
async function changeSession(session,action,name=''){
  await api('/api/sessions/'+encodeURIComponent(session.id)+'/manage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,name})});
  if(action==='rename'){const key=sessionKey(session),next=session.host_local===false?session.host+'~'+name:name;if(pins.includes(key))pins=pins.map(p=>p===key?next:p);delete aliases[key];savePreferences();}
  await refreshSessions(true);
}
async function deleteSession(session){if(!confirm(hostName(session)+' / '+session.name+qLangWorkspace.t('을 삭제할까요? 실행 중인 작업도 모두 종료됩니다.')))return;await changeSession(session,'delete');}
window.TmuxSessionActions={add:host=>openNewSession(host.id),rename:(session,name)=>changeSession(session,'rename',name),remove:async session=>{try{await deleteSession(session);}catch(error){notice(error.message);}},notice};
async function manageSessionAction(action){const session=managingSession;if(!session)return;try{if(action==='delete')await deleteSession(session);else await changeSession(session,action,$('session-new-name').value.trim());$('session-manage-dialog').close();}catch(error){$('session-manage-status').textContent=error.message;}}
$('session-rename-form').addEventListener('submit',event=>{event.preventDefault();manageSessionAction('rename');});$('session-delete').addEventListener('click',()=>manageSessionAction('delete'));
window.addEventListener('server-navigation-change',()=>{for(const id of ['terminal-sessions','reader-sessions'])$(id).dataset.sessions='';renderTerminalSessions();if(splitWorkspace){splitWorkspace.list.dataset.signature='';splitWorkspace.update();}});
async function openHostSetup(host){
  if(setupPending){notice(qLangWorkspace.t('서버 연결 설정이 진행 중이에요. 잠시 기다려 주세요.'));return;}
  setupHost=host.id;$('host-dialog-title').textContent=host.name+qLangWorkspace.t(' 연결');$('host-account').textContent=host.user+' @ '+host.name;
  hostTrustToken='';$('host-trust').checked=false;$('host-key-info').hidden=true;$('host-trust-label').hidden=true;
  $('host-password').value='';$('host-connect-status').textContent='';$('host-dialog').showModal();$('host-password').focus();
  if(host.verify_key){$('host-connect-status').textContent=qLangWorkspace.t('호스트 키 확인 중…');try{const result=await api('/api/hosts/'+encodeURIComponent(host.id)+'/key');if(setupHost!==host.id||!$('host-dialog').open)return;hostTrustToken=result.token;$('host-key-info').textContent=result.fingerprints.join('\n');$('host-key-info').hidden=false;$('host-trust-label').hidden=false;$('host-connect-status').textContent='';}catch(error){$('host-connect-status').textContent=error.message;}}
}
$('host-dialog').addEventListener('close',()=>{$('host-password').value='';});
$('host-connect-form').addEventListener('submit',async event=>{
  event.preventDefault();if(setupPending)return;
  const target=setupHost,password=$('host-password').value;if(!password)return;
  if(hosts.find(h=>h.id===target)?.verify_key&&(!hostTrustToken||!$('host-trust').checked)){$('host-connect-status').textContent=qLangWorkspace.t('호스트 키를 확인하고 신뢰 여부를 체크해 주세요.');return;}
  setupPending=true;$('host-connect-submit').disabled=true;$('host-password').value='';$('host-connect-status').textContent=qLangWorkspace.t('연결 설정 중…');
  try{
    await api('/api/hosts/'+encodeURIComponent(target)+'/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password,trust:hostTrustToken})});
    await refreshSessions(true);const host=hosts.find(item=>item.id===target);
    if(host?.connected){$('host-dialog').close();notice(host.name+qLangWorkspace.t(' 연결 완료'));}
    else $('host-connect-status').textContent=qLangWorkspace.t('로그인은 연결됐어요. ')+(host?.status||qLangWorkspace.t('작업 목록을 다시 확인해 주세요.'));
  }catch(error){$('host-connect-status').textContent=error.message;}
  finally{setupPending=false;$('host-connect-submit').disabled=false;}
});
function renderSessions(){
  renderHosts();
  const query=$('session-search').value.toLowerCase();
  const sessions=inventory.filter(item=>[item.name,sessionName(item),item.host,item.host_address,hostName(item),item.path,...item.panes.map(pane=>pane.command+' '+pane.title)].join(' ').toLowerCase().includes(query));
  sessions.sort((a,b)=>Number(pins.includes(sessionKey(b)))-Number(pins.includes(sessionKey(a)))||hostName(a).localeCompare(hostName(b))||a.name.localeCompare(b.name));
  $('session-count').textContent=String(inventory.length);$('session-cards').replaceChildren();
  for(const session of sessions){
    const card=element('article','', 'session-card'+(pins.includes(sessionKey(session))?' pinned':''));
    ServerNavigation.paint(card,session.host);
    const open=element('button','','session-open');open.dataset.session=session.id;open.type='button';
    const tools=[...new Set(session.panes.map(pane=>pane.command).filter(Boolean))].slice(0,3).join(' · ');
    open.append(element('span',hostName(session)+' · '+(tools||qLangWorkspace.t('작업 공간')),'card-eyebrow'),element('strong',sessionName(session),'card-name'));
    if(aliases[sessionKey(session)])open.append(element('span',session.name,'card-original'));
    open.append(element('span',shortPath(session.path)||qLangWorkspace.t('프로젝트 경로 없음'),'card-path'),element('span',qLangWorkspace.f("화면 {0}개 · 터미널 연결 {1}개",[session.pane_count,session.attached]),'card-meta'));
    open.addEventListener('click',()=>openSession(session.id));
    const pin=element('button',pins.includes(sessionKey(session))?'★':'☆','quiet card-pin');pin.type='button';pin.setAttribute('aria-label',hostName(session)+' '+session.name+qLangWorkspace.t(' 고정'));pin.setAttribute('aria-pressed',String(pins.includes(sessionKey(session))));pin.addEventListener('click',()=>togglePin(session));
    card.append(open,pin);$('session-cards').append(card);
  }
  $('sessions-empty').hidden=sessions.length>0;$('sessions-empty').textContent=query?qLangWorkspace.t('검색 결과가 없어요.'):qLangWorkspace.t('실행 중인 작업이 없어요.');
  const selected=sessionId;$('sessions').replaceChildren();for(const session of inventory)$('sessions').append(new Option(hostName(session)+' · '+sessionName(session),session.id));if(selected)$('sessions').value=selected;
  renderTerminalSessions();
  splitWorkspace?.update();
}
function renderTerminalSessions(){
  renderSessionButtons($('terminal-sessions'),'terminalSession',switchSession);
  renderSessionButtons($('reader-sessions'),'readerSession',switchSession);
}
function renderSessionButtons(list,attribute,onSelect){
  const groups=hosts.length?hosts:[{id:'',name:'Local',connected:true}];
  const ids=JSON.stringify([inventory.map(item=>item.id),groups]);
  if(list.dataset.sessions!==ids){list.replaceChildren();for(const host of groups){
    const group=ServerNavigation.group(host,()=>window.dispatchEvent(new Event('server-navigation-change')),openHostSetup,openServerEditor);list.append(group.section);
    for(const session of inventory.filter(item=>!host.id||item.host===host.id)){const button=element('button',sessionName(session));button.type='button';button.dataset[attribute]=session.id;button.addEventListener('click',()=>onSelect(session.id));group.items.append(ServerNavigation.row(session,button,openSessionManager));}
  }list.append(ServerNavigation.add(()=>openServerEditor()));list.dataset.sessions=ids;}
  for(const button of list.querySelectorAll('button[data-'+attribute.replace(/[A-Z]/g,m=>'-'+m.toLowerCase())+']')){const session=inventory.find(item=>item.id===button.dataset[attribute]);if(!session)continue;button.textContent=sessionName(session);button.title=hostName(session)+' / '+session.name;button.setAttribute('aria-current',String(session.id===sessionId));}
}
function switchSession(id){
  if(splitWorkspace){splitWorkspace.select(id);return;}
  if(id===sessionId)return;
  const previousMode=mode,expanded=terminalExpanded,readingExpanded=readerExpanded;openSession(id);
  if(previousMode==='terminal')setMode('terminal',expanded);
  else if(readingExpanded)setReaderExpanded(true);
}
function showManager(){
  directInput.select();
  if(panelClient&&parent!==window){panelMessage({action:'manager'});return;}
  splitWorkspace?.hide();
  setTerminalExpanded(false);setReaderExpanded(false);if(paneId)drafts.set(paneId,$('message').value);stopReader();detachTerminal();sessionId='';paneId='';deliveryPanel.select('');$('task-view').hidden=true;$('sessions-view').hidden=false;status(qLangWorkspace.t('연결됨'),true);
}
function openSession(id){
  if(splitWorkspace){splitWorkspace.open(id);return;}
  if(paneId)drafts.set(paneId,$('message').value);stopReader();detachTerminal();sessionId=id;
  const session=selectedSession();if(!session)return showManager();
  localStorage.setItem('tmux-mobile-session',id);$('sessions-view').hidden=true;$('task-view').hidden=false;
  const remembered=stored('tmux-last-panes',{});
  const pane=session.panes.find(item=>item.id===remembered[id])||session.panes.find(item=>item.active)||session.panes[0];
  paneId='';mode='reader';renderTask();if(pane)choosePane(pane.id,false);setMode('reader');
}
function renderTask(){
  const session=selectedSession();if(!session)return;
  renderTerminalSessions();
  $('sessions').value=session.id;$('task-name').textContent=sessionName(session);$('task-path').textContent=hostName(session)+' · '+shortPath(selectedPane()?.path||session.path);
  $('pane-count').textContent=qLangWorkspace.f("화면 {0}개",[session.pane_count]);$('pin-current').textContent=pins.includes(sessionKey(session))?'★':'☆';
  $('pane-tabs').replaceChildren();
  for(const pane of session.panes){const button=element('button','');button.type='button';button.dataset.pane=pane.id;button.setAttribute('aria-pressed',String(pane.id===paneId));const subtitle=[...new Set([pane.window_name,pane.command].filter(Boolean))].join(' · ');button.append(element('strong',paneName(pane)),element('small',`${subtitle}${pane.dead?qLangWorkspace.t(' · 종료됨'):''}`));button.addEventListener('click',()=>choosePane(pane.id));$('pane-tabs').append(button);}
  const pane=selectedPane();$('reader-name').textContent=pane?`${paneName(pane)} · ${pane.command}`:qLangWorkspace.t('화면을 선택하세요');
  if(panelClient){for(const select of document.querySelectorAll('.panel-pane-select')){const signature=JSON.stringify(session.panes.map(item=>[item.id,paneName(item)]));if(select.dataset.panes!==signature){select.replaceChildren();for(const item of session.panes)select.add(new Option(paneName(item),item.id));select.dataset.panes=signature;}select.value=paneId;select.hidden=session.panes.length<2;}}
  $('input-target').textContent=hostName(session)+' · '+(pane?paneName(pane):qLangWorkspace.t('화면 선택'));$('input-target').title=qLangWorkspace.t('입력 대상: ')+hostName(session)+' · '+(pane?paneName(pane):qLangWorkspace.t('화면을 선택하세요'));
  $('send-message').disabled=pending||!pane;
  renderAttachments();
  publishPanelState();
}
function choosePane(id,poll=true){
  if(id===paneId)return;if(paneId)drafts.set(paneId,$('message').value);
  directInput.select();stopReader();paneId=id;readerVersion='';readerText='';readerRenderedAnsi=null;pendingReader=null;readerMore=false;historyLoading=false;readerAutoLoads=0;follow=true;terminalTouch.select(id);conversationReader.select(id);questionPanel.select(id);deliveryPanel.select(id);$('reader-live-status').hidden=true;delete $('reader-card').dataset.agent;$('load-history').hidden=true;$('new-output').hidden=true;$('message').value=drafts.get(id)||'';$('send-state').textContent='';
  const remembered=stored('tmux-last-panes',{});remembered[sessionId]=id;localStorage.setItem('tmux-last-panes',JSON.stringify(remembered));
  agentControls.select(id);
  $('reader-content').replaceChildren(element('p',qLangWorkspace.t('최근 출력을 불러오고 있어요.'),'empty'));renderTask();
  composerHeight=Number.isFinite(composerHeights[id])?composerHeights[id]:null;fitComposerHeight();
  if(mode==='reader'&&poll)startReader();
}
function isOutputMeta(line){
  const value=line.trim();
  if(/^Worked for \d+(?:\.\d+)?(?:[smh]\b|\s+(?:seconds?|minutes?|hours?)\b)/i.test(value))return true;
  if(/^(?:Opus|Sonnet|Haiku)\b.*(?:\||tokens?|\d%)/i.test(value)||/^(?:⏵|Tip:|\(ctrl\+b|[•·✻✽]\s*(?:Working|Thinking|Undulating|Reasoning)\b)/i.test(value))return true;
  if(/^(?:gpt[- ]?\d[\w.-]*|o[134](?:-[\w.-]+)?|codex(?:-[\w.-]+)?)\b/i.test(value)&&/[·|]/.test(value)&&/\b(?:context|weekly|full access|read.only|used|left|tokens?)\b/i.test(value))return true;
  return /^(?:Token usage|(?:input|output|total|cached) tokens|tokens used|context(?: window)?|weekly(?: limit| usage)?)[\s:=]+\d/i.test(value)||/^[←?]\s+for (?:agents|shortcuts)\b/i.test(value);
}
function fitReaderTables(){TmuxReader.fitTables($('reader-content'));TmuxReader.fitTables($('reader-interaction'));if(follow)$('reader-scroll').scrollTop=$('reader-scroll').scrollHeight;}
new ResizeObserver(fitReaderTables).observe($('reader-scroll'));
// Pictures and previews finish loading after a render and grow the content; stay at the bottom while following.
new ResizeObserver(()=>{if(follow&&!readerZooming&&!panelRestoring)$('reader-scroll').scrollTop=$('reader-scroll').scrollHeight;}).observe($('reader-content'));
document.fonts.addEventListener('loadingdone',fitReaderTables);
$('reader-content').addEventListener('toggle',event=>{
  if(event.target.tagName!=='DETAILS'||!event.target.open)return;
  requestAnimationFrame(()=>TmuxReader.fitTables($('reader-content')));
},true);
$('reader-content').addEventListener('click',event=>{
  if(!event.target.closest('.reader-activity>summary,.reader-media>summary,.reader-question-preview>summary,[data-image-viewer]'))return;
  follow=false;$('follow-output').setAttribute('aria-pressed','false');$('follow-output').textContent=qLangWorkspace.t('최신 따라가기');
});
function readerAnchor(){
  const area=$('reader-scroll'),top=area.getBoundingClientRect().top;
  const block=[...$('reader-content').querySelectorAll('.reader-question-set,.output-block,.reader-table-shell,.reader-activity,.reader-media')].find(node=>node.getBoundingClientRect().height>0&&node.getBoundingClientRect().bottom>top+2);
  return block?{text:block.textContent.slice(0,240),top:block.getBoundingClientRect().top-top}:null;
}
function restoreReaderAnchor(anchor,before,height){
  const area=$('reader-scroll');
  const block=anchor&&[...$('reader-content').querySelectorAll('.reader-question-set,.output-block,.reader-table-shell,.reader-activity,.reader-media')].find(node=>node.textContent.startsWith(anchor.text));
  if(block)area.scrollTop+=block.getBoundingClientRect().top-area.getBoundingClientRect().top-anchor.top;
  else area.scrollTop=before+area.scrollHeight-height;
}
function renderOutput(text,ansi=text,prepend=false,messages=null){
  const displayAnsi=messages?null:TmuxReader.withoutCodexFooter(ansi);
  if(!prepend&&!messages&&displayAnsi===readerRenderedAnsi){readerText=text;pendingReader=null;$('new-output').hidden=true;return;}
  const area=$('reader-scroll'),before=area.scrollTop,height=area.scrollHeight,anchor=!follow?readerAnchor():null;
  if(!follow&&!prepend){pendingReader={text,ansi,messages};$('new-output').hidden=false;return;}
  if(prepend)$('load-history').hidden=!readerMore;
  const open=new Set([...$('reader-content').querySelectorAll('details[open]')].map(node=>node.dataset.readerKey));readerText=text;
  const content=messages?TmuxReader.renderMessages(messages,isOutputMeta):TmuxReader.render(ansi,isOutputMeta);readerRenderedAnsi=displayAnsi;readerMessages=messages;
  $('reader-content').replaceChildren(content.childNodes.length?content:element('p',qLangWorkspace.t('아직 출력이 없어요.'),'empty'));
  for(const node of $('reader-content').querySelectorAll('details'))if(open.has(node.dataset.readerKey))node.open=true;
  TmuxReader.fitTables($('reader-content'));
  if(follow){area.scrollTop=area.scrollHeight;$('new-output').hidden=true;}else restoreReaderAnchor(anchor,before,height);
  $('follow-output').setAttribute('aria-pressed',String(follow));$('follow-output').textContent=follow?qLangWorkspace.t('최신 따라가기 ✓'):qLangWorkspace.t('최신 따라가기');
  requestAnimationFrame(()=>{
    if(mode==='reader'&&conversationReader.supported&&readerMore&&!historyLoading&&readerAutoLoads<12&&area.scrollHeight<=area.clientHeight+12){readerAutoLoads++;loadReaderHistory({fill:follow});}
  });
}
function startReader(){stopReader();if(!panelVisible)return;const generation=readerGeneration;pollReader(generation);}
const asyncQuestionPending=new Set();
$('reader-content').addEventListener('reader-question-answer',async event=>{
  const target=paneId,session=conversationReader.session,detail=event.detail,key=target+':'+detail.call_id+':'+detail.question_id;
  if(asyncQuestionPending.has(key))return;
  const article=event.target.closest('.reader-question-set');asyncQuestionPending.add(key);
  for(const button of article.querySelectorAll('.reader-question-select'))button.disabled=true;
  try{await sendPane({type:'async_question',...detail,session_id:session,request_id:crypto.randomUUID()},target);notice(qLangWorkspace.t('선택한 답변을 보냈어요.'));if(paneId===target){const data=await conversationReader.poll(true);if(data&&!data.status_only)renderOutput(data.text,data.text,true,data.messages);startReader();}}
  catch(error){notice(error.message);for(const button of article.querySelectorAll('.reader-question-select'))button.disabled=false;}
  finally{asyncQuestionPending.delete(key);}
});
function renderLiveStatus(agent,value){
  const area=$('reader-live-status'),signature=JSON.stringify([agent,value]);
  if(agent)$('reader-card').dataset.agent=agent;
  if(area.dataset.lines!==signature){area.replaceChildren(...(value?[agent==='codex'?TmuxReader.renderCodexStatus(value):TmuxReader.renderMeta(value.map(text=>({text})))]:[]));area.dataset.lines=signature;}
  area.hidden=!value||(Array.isArray(value)&&!value.length);
}
async function pollReader(generation){
  if(generation!==readerGeneration||mode!=='reader'||!paneId||document.hidden)return;
  const target=paneId;
  try{
    const [native]=await Promise.all([conversationReader.poll(selectedPane()?.command==='claude'),questionPanel.poll()]);
    if(generation!==readerGeneration||paneId!==target)return;
    if(native&&!native.status_only){
      readerVersion='';
      renderLiveStatus(native.source||'claude',native.source==='codex'?native.usage_status:native.status_lines||[]);
      if(!historyLoading){readerMore=native.history_more;$('load-history').hidden=!readerMore;const questionChanged=JSON.stringify((readerMessages||[]).filter(m=>m.question).map(m=>m.question))!==JSON.stringify(native.messages.filter(m=>m.question).map(m=>m.question));if(native.changed||readerText!==native.text){renderOutput(native.text,native.text,questionChanged,native.messages);if(native.source==='claude'&&!native.messages.length)$('reader-content').replaceChildren(element('p',qLangWorkspace.t('Claude에 연결됐어요. 아래에서 대화를 시작하세요.'),'empty'));}}
      lastChangeLabel=()=>(native.source==='codex'?qLangWorkspace.t('Codex 대화 기록'):qLangWorkspace.t('Claude 대화 기록'))+' · '+new Date(native.changed_at*1000).toLocaleTimeString(qLangWorkspace.locale,{hour:'2-digit',minute:'2-digit',second:'2-digit'});$('last-change').textContent=lastChangeLabel();status(qLangWorkspace.t('실시간 연결'),true);
    }else{
    const history=readerHistory.get(target)||800,data=await api(`/api/panes/${encodeURIComponent(target)}/snapshot?version=${encodeURIComponent(readerVersion)}&history=${history}`);
    if(generation!==readerGeneration||paneId!==target)return;
    const usage=native?.usage_status||TmuxReader.codexStatus(data.text||'');
    if(native?.usage_status||typeof data.text==='string')renderLiveStatus(usage?'codex':'',usage);
    if(!historyLoading&&history===(readerHistory.get(target)||800)){
      readerMore=data.history_more;$('load-history').hidden=!readerMore;
      if(data.changed){readerVersion=data.version;renderOutput(data.text,data.ansi??data.text);}
    }
    lastChangeLabel=()=>qLangWorkspace.t('최근 변경 ')+new Date(data.changed_at*1000).toLocaleTimeString(qLangWorkspace.locale,{hour:'2-digit',minute:'2-digit',second:'2-digit'});$('last-change').textContent=lastChangeLabel();status(qLangWorkspace.t('실시간 연결'),true);
    }
  }catch(error){if(generation!==readerGeneration)return;if(error.status===401)return;if(error.status===404){notice(error.message);stopReader();return;}status(qLangWorkspace.t('다시 연결 중'));}
  if(generation===readerGeneration)readerTimer=setTimeout(()=>pollReader(generation),1200);
}
async function loadReaderHistory(options={}){
  if(historyLoading||!readerMore||!paneId||mode!=='reader')return;
  const target=paneId,generation=readerGeneration,button=$('load-history');historyLoading=true;button.disabled=true;button.textContent=qLangWorkspace.t('이전 대화 불러오는 중…');
  try{
    if(conversationReader.supported){
      const data=await conversationReader.older();if(!data||target!==paneId||generation!==readerGeneration)return;
      readerMore=data.history_more;pendingReader=null;if(!options.fill)follow=false;renderOutput(data.text,data.text,true,data.messages);
    }else{
    const history=Math.min(100000,(readerHistory.get(target)||800)+1600),data=await api(`/api/panes/${encodeURIComponent(target)}/snapshot?history=${history}`);
    if(target!==paneId||generation!==readerGeneration)return;
    if(typeof data.text==='string'){const usage=TmuxReader.codexStatus(data.text);renderLiveStatus(usage?'codex':'',usage);}
    readerHistory.set(target,history);readerMore=data.history_more;readerVersion=data.version;pendingReader=null;follow=false;
    renderOutput(data.text,data.ansi??data.text,true);
    }
  }catch(error){if(target===paneId)notice(error.message);}
  finally{if(target===paneId){historyLoading=false;button.disabled=false;button.textContent=qLangWorkspace.t('이전 대화 더 보기 ↑');}}
}
function terminalTheme(){
  const style=getComputedStyle(document.documentElement),color=(name,fallback)=>style.getPropertyValue(name).trim()||fallback;
  const common={background:color('--q-paper','#101012'),foreground:color('--q-ink','#e4e4e7'),cursor:color('--q-action','#d6d6db'),selectionBackground:color('--q-selected','#2b2b30')};
  return window.AppTheme?.theme==='light'?{...common,black:'#17171b',red:'#8e3438',green:'#405b47',yellow:'#735b30',blue:'#364e5b',magenta:'#70516e',cyan:'#3d5f63',white:'#b1b1ba',brightBlack:'#60606b',brightRed:'#8e3438',brightGreen:'#405b47',brightYellow:'#735b30',brightBlue:'#364e5b',brightMagenta:'#70516e',brightCyan:'#3d5f63',brightWhite:'#f4f4f5'}:common;
}
window.addEventListener('app-theme-change',()=>{if(terminal){terminal.options.minimumContrastRatio=window.AppTheme?.theme==='light'?4.5:1;terminal.options.fontWeight=window.AppTheme?.theme==='light'?450:400;terminal.options.theme=terminalTheme();}});
async function createTerminal(){
  if(terminal)return;
  if(!terminalFontPromise)terminalFontPromise=Promise.all([document.fonts.load('400 13px "Cascadia Code"'),document.fonts.load('700 13px "Cascadia Code"')]).catch(()=>notice(qLangWorkspace.t('코딩 글꼴을 불러오지 못해 기본 글꼴로 표시해요. 새로고침해 주세요.')));
  await terminalFontPromise;
  if(terminal||mode!=='terminal')return;
  terminal=new Terminal({cursorBlink:true,fontSize:desktopTerminal()?13*terminalTouch.zoom:13,fontFamily:getComputedStyle(document.documentElement).getPropertyValue('--font-code').trim(),fontWeight:window.AppTheme?.theme==='light'?450:400,fontWeightBold:700,scrollback:10000,minimumContrastRatio:window.AppTheme?.theme==='light'?4.5:1,theme:terminalTheme()});terminal.open($('terminal'));
  // xterm 5.5 has no public coordinate hook and assumes an unscaled screen.
  // Translate selection and mouse reports so a scaled tap still hits its cell.
  const mouse=terminal._core._mouseService;
  for(const name of ['getCoords','getMouseReportCoords']){const read=mouse[name].bind(mouse);mouse[name]=(event,node,...args)=>{const rect=node.getBoundingClientRect();const point={clientX:rect.left+(event.clientX-rect.left)*(node.offsetWidth/rect.width||1),clientY:rect.top+(event.clientY-rect.top)*(node.offsetHeight/rect.height||1)};return read(point,node,...args);};}
  terminal.onData(data=>{if(terminalReady){if(ctrl&&data.length===1&&/[a-zA-Z]/.test(data))data=String.fromCharCode(data.toUpperCase().charCodeAt(0)-64);rawInput(data);setCtrl(false);}});
  terminal.onBinary(data=>{if(terminalReady)rawInput(data,true);});
  terminal.onRender(scheduleTerminalFit);new ResizeObserver(scheduleTerminalFit).observe($('terminal-scroll'));
}
function terminalSize(){
  const area=$('terminal-scroll'),cell=terminal?._core._renderService.dimensions.css.cell;
  if(desktopTerminal()&&cell?.width&&cell?.height&&area.clientWidth&&area.clientHeight){
    const style=getComputedStyle(area),width=area.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),height=area.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
    return{cols:Math.max(20,Math.min(500,Math.floor(width/cell.width))),rows:Math.max(5,Math.min(200,Math.floor(height/cell.height)))};
  }
  const size=selectedSession()?.terminal;return{cols:Math.max(20,Math.min(500,size?.cols||100)),rows:Math.max(5,Math.min(200,size?.rows||40))};
}
function scheduleTerminalFit(){if(!terminalFrame)terminalFrame=requestAnimationFrame(()=>{terminalFrame=0;fitTerminal();});}
function fitTerminal(){
  if(!terminal||mode!=='terminal')return;
  const fontSize=desktopTerminal()?13*terminalTouch.zoom:13;if(Math.abs(terminal.options.fontSize-fontSize)>.001)terminal.options.fontSize=fontSize;
  resize(false);
  const area=$('terminal-scroll'),screen=$('terminal').querySelector('.xterm-screen');if(!screen||!area.clientWidth||!area.clientHeight)return;
  const style=getComputedStyle(area),width=screen.offsetWidth,height=screen.offsetHeight;if(!width||!height)return;
  const availableWidth=area.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),availableHeight=area.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
  const scale=Math.min(1,availableWidth/width,availableHeight/height)*(desktopTerminal()?1:terminalTouch.zoom);if(scale<=0)return;
  Object.assign($('terminal-stage').style,{width:width*scale+'px',height:height*scale+'px',marginTop:$('terminal-history').hidden?Math.max(0,(availableHeight-height*scale)/2)+'px':'0px'});
  Object.assign($('terminal').style,{width:width+'px',height:height+'px',transform:`scale(${scale})`});
  $('terminal-size').textContent=`${terminal.cols} × ${terminal.rows} · ${Math.round(scale*100)}%`;
  terminalTouch.fitHistory(scale*(desktopTerminal()?terminalTouch.zoom:1));
}
function resize(schedule=true){if(!terminal||mode!=='terminal')return;const size=terminalSize();if(terminal.cols!==size.cols||terminal.rows!==size.rows){terminal.resize(size.cols,size.rows);if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'resize',...size}));}if(schedule)scheduleTerminalFit();}
function updateTerminalViewport(){const viewport=window.visualViewport;document.documentElement.style.setProperty('--terminal-viewport-height',(viewport?.height||innerHeight)+'px');document.documentElement.style.setProperty('--terminal-viewport-top',(viewport?.offsetTop||0)+'px');fitComposerScale();fitComposerHeight();resize();}
function fitComposerScale(){
  const form=$('compose-form'),requested=viewZoom?.values.composer||1,available=Math.max(panelClient?110:80,(visualViewport?.height||innerHeight)*.48),box=directInput.box;
  form.style.setProperty('--composer-zoom','1');form.style.setProperty('--input-text-zoom',String(requested));form.style.zoom='1';form.style.maxHeight='none';box.style.zoom='1';box.style.width='100%';
  if(directInput.enabled){let scale=1;for(let pass=0;pass<3;pass++){const height=Math.max(form.getBoundingClientRect().height,form.scrollHeight+2);if(height<=available)break;const boxHeight=box.getBoundingClientRect().height,fixed=height-boxHeight;scale*=Math.max(.1,(available-fixed-2)/Math.max(1,boxHeight));box.style.zoom=String(scale);}}
  form.style.maxHeight=available+'px';
}
function fitComposerHeight(){
  const input=$('message'),handle=$('composer-resize');if(!input||!handle)return;
  if(input.hidden)return;
  const scale=viewZoom?.values.composer||1,font=parseFloat(getComputedStyle(input).fontSize)||16,viewport=visualViewport?.height||innerHeight,form=$('compose-form'),frame=directInput.messageFrame;
  const fixed=Math.max(0,form.scrollHeight-frame.getBoundingClientRect().height),budget=Math.max(panelClient?110:80,viewport*.48)-fixed-2;
  const max=Math.max(34,Math.min(420,Math.floor(viewport*.36),budget)),min=Math.min(max,Math.max(phoneClient()?34:28,Math.ceil(font*scale*1.6)+6)),scroll=input.scrollTop;
  // scrollHeight measures soft-wrapped lines at the textarea's logical width.
  Object.assign(input.style,{height:'0px',minHeight:'0px',maxHeight:'none'});
  const natural=input.scrollHeight*scale,height=Math.max(min,Math.min(max,Math.max(natural,composerHeight||0)));
  Object.assign(input.style,{height:height/scale+'px',minHeight:min/scale+'px',maxHeight:max/scale+'px'});
  directInput.messageFrame.style.height=input.getBoundingClientRect().height+'px';
  input.scrollTop=input.selectionEnd===input.value.length?input.scrollHeight:scroll;
  for(const [key,value] of Object.entries({min,max,now:Math.round(input.getBoundingClientRect().height)}))handle.setAttribute('aria-value'+key,String(value));
}
function rememberComposerHeight(){if(paneId){if(composerHeight===null)delete composerHeights[paneId];else composerHeights[paneId]=composerHeight;try{localStorage.setItem('tmux-composer-heights',JSON.stringify(composerHeights));}catch{}}}
function installComposerResize(){
  const input=$('message'),handle=element('div','','composer-resize');handle.id='composer-resize';handle.tabIndex=0;
  for(const [key,value] of Object.entries({role:'separator','aria-label':qLangWorkspace.t('입력창 높이 조절'),'aria-orientation':'horizontal','aria-controls':'message'}))handle.setAttribute(key,value);
  handle.title=qLangWorkspace.t('위아래로 끌어 입력창 높이 조절 · 두 번 누르면 기본 높이');$('compose-form').prepend(handle);
  const set=value=>{const min=Number(handle.getAttribute('aria-valuemin')),max=Number(handle.getAttribute('aria-valuemax'));composerHeight=Math.max(min,Math.min(max,value));updateTerminalViewport();if(follow)fitReaderTables();};
  handle.addEventListener('pointerdown',event=>{
    if(event.button!==0||!event.isPrimary)return;event.preventDefault();composerResizeEnd?.();fitComposerHeight();
    const start=event.clientY,initial=input.getBoundingClientRect().height,pointer=event.pointerId;
    handle.setPointerCapture(pointer);document.documentElement.classList.add('composer-resizing');
    const move=event=>{if(event.pointerId===pointer){event.preventDefault();set(initial+start-event.clientY);}};
    const finish=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',up);window.removeEventListener('blur',finish);window.removeEventListener('keydown',key);if(handle.hasPointerCapture(pointer))handle.releasePointerCapture(pointer);document.documentElement.classList.remove('composer-resizing');composerResizeEnd=null;rememberComposerHeight();};
    const up=event=>{if(event.pointerId===pointer)finish();},key=event=>{if(event.key==='Escape')finish();};composerResizeEnd=finish;
    window.addEventListener('pointermove',move,{passive:false});window.addEventListener('pointerup',up);window.addEventListener('pointercancel',up);window.addEventListener('blur',finish);window.addEventListener('keydown',key);
  });
  handle.addEventListener('dblclick',()=>{composerHeight=null;rememberComposerHeight();updateTerminalViewport();});
  handle.addEventListener('keydown',event=>{if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();fitComposerHeight();set(event.key==='Home'?Number(handle.getAttribute('aria-valuemin')):event.key==='End'?Number(handle.getAttribute('aria-valuemax')):input.getBoundingClientRect().height+(event.key==='ArrowUp'?16:-16));rememberComposerHeight();});
  fitComposerHeight();
}
function updateSessionSidebar(){
  $('task-view').classList.toggle('sidebar-active',!terminalExpanded&&!readerExpanded);$('reader-session-sidebar').hidden=terminalExpanded;
}
function moveComposer(target){
  const input=$('message'),focused=document.activeElement===input,selection=[input.selectionStart,input.selectionEnd,input.selectionDirection];
  if($('compose-form').parentElement===target)return;
  // Restoring focus after an asynchronous view change cannot open iOS's keyboard.
  // Leave touch clients ready for a real tap instead of keeping invisible focus.
  if(focused&&phoneClient())input.blur();
  if($('composer-toggle'))target.append($('composer-toggle'));target.append($('compose-form'));if(focused){if(!phoneClient())input.focus({preventScroll:true});input.setSelectionRange(...selection);}
}
function setReaderExpanded(value){
  if(value===readerExpanded)return;
  if(value){setTerminalExpanded(false);readerFullscreenScroll=window.scrollY;}
  const area=$('reader-scroll'),anchor=readerAnchor(),before=area.scrollTop,height=area.scrollHeight,target=paneId;
  readerExpanded=value;document.documentElement.classList.toggle('reader-expanded',value);$('reader-card').classList.toggle('is-fullscreen',value);
  if(value)$('reader-sidebar-slot').append($('reader-session-sidebar'));else $('task-view').insertBefore($('reader-session-sidebar'),$('task-main'));
  $('reader-fullscreen').setAttribute('aria-pressed',String(value));$('reader-fullscreen').textContent=value?qLangWorkspace.t('닫기 ✕'):qLangWorkspace.t('전체 화면 ⛶');
  moveComposer(value?$('reader-main'):$('composer-slot'));updateSessionSidebar();updateTerminalViewport();
  if(!value)window.scrollTo(0,readerFullscreenScroll);
  requestAnimationFrame(()=>{if(target!==paneId||mode!=='reader')return;TmuxReader.fitTables($('reader-content'));if(follow)area.scrollTop=area.scrollHeight;else restoreReaderAnchor(anchor,before,height);});
}
function setTerminalExpanded(value){
  if(value===terminalExpanded)return;if(value){setReaderExpanded(false);fullscreenScroll=window.scrollY;}terminalExpanded=value;
  document.documentElement.classList.toggle('terminal-expanded',value);$('terminal-card').classList.toggle('is-fullscreen',value);
  updateSessionSidebar();
  $('terminal-fullscreen').setAttribute('aria-pressed',String(value));$('terminal-fullscreen').textContent=value?qLangWorkspace.t('닫기 ✕'):qLangWorkspace.t('전체 화면 ⛶');
  moveComposer(value?$('terminal-main'):$('composer-slot'));
  updateTerminalViewport();if(!value)window.scrollTo(0,fullscreenScroll);resize();
}
async function connectTerminal(){
  if(!panelVisible)return;
  detachTerminal();const target=sessionId,generation=terminalGeneration;if(!target)return;status(qLangWorkspace.t('터미널 준비 중'));await createTerminal();if(generation!==terminalGeneration||mode!=='terminal'||sessionId!==target||!terminal)return;terminal.reset();resize();status(qLangWorkspace.t('터미널 연결 중'));
  const url=new URL('/api/terminal',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';url.search=new URLSearchParams({session:sessionId,...terminalSize(),sizing:desktopTerminal()?'window':'mirror',build:'20261102-reading1',viewport:`${innerWidth}x${innerHeight}`,pointer:matchMedia('(hover: hover) and (pointer: fine)').matches?'fine':'coarse'});
  const active=new WebSocket(url);let failure='';socket=active;active.binaryType='arraybuffer';
  active.onopen=()=>{if(socket===active)reconnectAttempt=0;};
  active.onmessage=event=>{if(socket!==active)return;if(typeof event.data==='string'){try{const data=JSON.parse(event.data);if(data.type==='error'){failure=data.message;notice(failure);status(failure);}}catch{}return;}if(event.data instanceof ArrayBuffer)terminal.write(new Uint8Array(event.data),()=>{if(socket===active&&!terminalReady){terminalReady=true;status(qLangWorkspace.t('터미널 연결'),true);}});};
  active.onclose=()=>{if(socket!==active)return;terminalReady=false;status(failure||qLangWorkspace.t('연결 끊김'));if(!failure&&mode==='terminal'&&sessionId&&!document.hidden)reconnectTimer=setTimeout(connectTerminal,Math.min(30000,1000*2**Math.min(reconnectAttempt++,5)));};
}
function rawInput(data,binary=false){if(!terminalReady||socket?.readyState!==WebSocket.OPEN){notice(qLangWorkspace.t('터미널이 연결될 때까지 기다려 주세요.'));return false;}socket.send(JSON.stringify({type:'input',data,...binary?{binary:true}:{}}));return true;}
async function terminalTap(point){
  if(mode!=='terminal'||!terminalReady||!terminal||!$('terminal-history').hidden)return;
  const screen=$('terminal').querySelector('.xterm-screen'),rect=screen?.getBoundingClientRect();
  if(!rect||point.clientX<rect.left||point.clientX>=rect.right||point.clientY<rect.top||point.clientY>=rect.bottom)return;
  if(terminal.buffer.active.viewportY!==terminal.buffer.active.baseY)return;
  const pos=terminal._core._mouseService.getMouseReportCoords(point,screen);if(!pos)return;
  const mouse=terminal._core.coreMouseService;
  const click=()=>{if(mouse.areMouseEventsActive){mouse.triggerMouseEvent({...pos,button:0,action:1,ctrl:false,alt:false,shift:false});mouse.triggerMouseEvent({...pos,button:0,action:0,ctrl:false,alt:false,shift:false});}};
  const session=selectedSession(),source=sessionId,generation=terminalGeneration,cols=terminal.cols,rows=terminal.rows;
  const pane=session?.panes.find(pane=>pane.window_id===session.terminal?.window_id&&(session.terminal.zoomed?pane.active:pos.col>=pane.left&&pos.col<pane.left+pane.width&&pos.row>=pane.top&&pos.row<pane.top+pane.height));
  if(!pane){click();return;}
  const rendered=Array.from({length:pane.height},(_,row)=>terminal.buffer.active.getLine(terminal.buffer.active.viewportY+pane.top+row)?.translateToString(true,pane.left,pane.left+pane.width)||'').join('\n').replace(/[│┃\s]/g,'');
  try{const data=await api('/api/panes/'+encodeURIComponent(pane.id)+'/interaction?grid=1'),frame=data.interaction;
    if(source!==sessionId||generation!==terminalGeneration||mode!=='terminal'||cols!==terminal.cols||rows!==terminal.rows)return;
    if(frame){if(frame.grid.cols!==pane.width||frame.grid.rows!==pane.height)return;
      if(frame.mouse){click();return;}
      const row=pos.row-pane.top,col=pos.col-pane.left,choice=frame.options.find(item=>row>=item.row&&row<item.row_end&&(item.col===undefined||col>=item.col&&col<item.col_end));
      if(choice&&frame.selected!==null){
        if(!rendered.includes(frame.title.replace(/[│┃\s]/g,''))||!rendered.includes(choice.label.replace(/\s/g,''))){notice(qLangWorkspace.t('질문 화면이 바뀌었어요. 새 화면에서 다시 눌러 주세요.'));return;}
        // Original-terminal input follows the attached client's ordered channel,
        // including the pointer event that selects a split pane first.
        if(!mouse.areMouseEventsActive&&!pane.active)return;
        const index=frame.options.findIndex(item=>item.number===choice.number),distance=index-frame.selected;
        const horizontal=frame.navigation_axis==='horizontal';
        click();rawInput((horizontal?(distance>0?'\x1b[C':'\x1b[D'):(distance>0?'\x1b[B':'\x1b[A')).repeat(Math.abs(distance))+(frame.kind==='multi'?' ':horizontal&&frame.select_key==='s'?'s':'\r'));return;
      }}
    click();
  }catch(error){notice(error.message);}
}
function setMode(value,expanded){
  if(value!=='reader')setReaderExpanded(false);
  mode=value;const reading=value==='reader';$('reader-card').hidden=!reading;$('terminal-card').hidden=reading;$('pane-tabs').hidden=!reading;$('reader-font').hidden=!reading;$('ctrl-toggle').hidden=reading;
  $('reader-mode').setAttribute('aria-pressed',String(reading));$('terminal-mode').setAttribute('aria-pressed',String(!reading));
  $('terminal-name').textContent=qLangWorkspace.f("{0} · {1} · 원본 터미널",[hostName(selectedSession()),sessionName(selectedSession())]);
  if(reading){setTerminalExpanded(false);setReaderExpanded(true);}else setTerminalExpanded(true);
  updateSessionSidebar();
  if(reading){detachTerminal();if(paneId)startReader();}else{stopReader();connectTerminal();}renderTask();
}
function setCtrl(value){ctrl=value;$('ctrl-toggle').setAttribute('aria-pressed',String(value));}
function publishPanelState(){
  if($('composer-toggle'))$('composer-toggle').textContent=composerCollapsed?qLangWorkspace.t('입력창 펼치기')+($('message').value||queuedAttachments(paneId).length?qLangWorkspace.t(' · 작성 중'):'')+' ▴':qLangWorkspace.t('입력창 접기 ▾');
  if(!panelReady||!panelClient)return;
  const dirty=pending||!!$('message').value||[...drafts.values()].some(value=>!!value)||[...attachmentDrafts.values()].some(files=>files.length);
  const state={action:'state',session:sessionId,pane:paneId,view:mode,dirty,zoom:viewZoom?.values};const signature=JSON.stringify(state);
  if(signature!==lastPanelState){lastPanelState=signature;panelMessage(state);}
  panelMessage({action:'edited'});
}
// Same-origin auxiliary windows transfer structured data, including File
// objects. Drafts and attachments stay in memory, never in URLs or storage.
window.TmuxPanelState={
  export(){
    if(paneId)drafts.set(paneId,$('message').value);
    const conversation={};for(const key of ['supported','session','source','version','cursor','changedAt','statusLines','usageStatus'])conversation[key]=conversationReader[key];conversation.items=[...conversationReader.items];
    return {version:1,busy:pending,session:sessionId,pane:paneId,view:mode,drafts:[...drafts],attachments:[...attachmentDrafts],intents:[...sendIntents],text:$('message').value,selection:[$('message').selectionStart,$('message').selectionEnd],collapsed:composerCollapsed,composerHeight,zoom:{...viewZoom?.values},follow,history:[...readerHistory],conversation,
      output:{text:readerText,ansi:readerRenderedAnsi,messages:readerMessages,scroll:$('reader-scroll').scrollTop,anchor:readerAnchor(),open:[...$('reader-content').querySelectorAll('details[open]')].map(node=>node.dataset.readerKey)}};
  },
  import(state){
    state=structuredClone(state);
    const session=inventory.find(item=>item.id===state?.session);
    if(state?.version!==1||!session||!session.panes.some(item=>item.id===state.pane))throw new Error(qLangWorkspace.t('작업 화면이 종료됐어요. 다른 화면을 선택해 주세요.'));
    if(pending)throw new Error(qLangWorkspace.t('전송이 끝난 뒤 창을 이동해 주세요.'));
    stopReader();detachTerminal();const visible=panelVisible;panelVisible=false;panelRestoring=true;
    if(sessionId!==state.session)switchSession(state.session);if(paneId!==state.pane)choosePane(state.pane,false);
    for(const [map,entries] of [[drafts,state.drafts],[attachmentDrafts,state.attachments],[sendIntents,state.intents],[readerHistory,state.history]]){map.clear();for(const entry of entries||[])map.set(...entry);}
    $('message').value=state.text||'';$('message').setSelectionRange(...(state.selection||[0,0]));
    composerCollapsed=state.collapsed===true;composerHeight=Number.isFinite(state.composerHeight)?state.composerHeight:null;$('compose-form').hidden=composerCollapsed;$('composer-toggle')?.setAttribute('aria-expanded',String(!composerCollapsed));
    for(const [region,value] of Object.entries(state.zoom||{}))viewZoom.set(region,value);
    conversationReader.select(paneId);for(const key of ['supported','session','source','version','cursor','changedAt','statusLines','usageStatus'])if(state.conversation&&key in state.conversation)conversationReader[key]=state.conversation[key];
    conversationReader.items=new Map(state.conversation?.items||[]);conversationReader.cache=null;
    follow=true;readerRenderedAnsi=null;if(state.output?.text)renderOutput(state.output.text,state.output.ansi??state.output.text,false,state.output.messages);
    for(const node of $('reader-content').querySelectorAll('details'))if(state.output?.open?.includes(node.dataset.readerKey))node.open=true;
    follow=state.follow!==false;$('follow-output').setAttribute('aria-pressed',String(follow));$('follow-output').textContent=follow?qLangWorkspace.t('최신 따라가기 ✓'):qLangWorkspace.t('최신 따라가기');
    panelVisible=visible;setMode(state.view==='terminal'?'terminal':'reader');renderTask();fitComposerHeight();publishPanelState();
    const target=paneId;requestAnimationFrame(()=>{if(target!==paneId){panelRestoring=false;return;}follow=state.follow!==false;if(follow)fitReaderTables();else{const area=$('reader-scroll');area.scrollTop=state.output?.scroll||0;restoreReaderAnchor(state.output?.anchor,area.scrollTop,area.scrollHeight);}requestAnimationFrame(()=>panelRestoring=false);});
  }
};
installComposerResize();
if(panelClient){
  const toggle=element('button','','composer-toggle');toggle.id='composer-toggle';toggle.type='button';toggle.setAttribute('aria-controls','compose-form');$('compose-form').before(toggle);
  const fold=value=>{composerCollapsed=value;$('compose-form').hidden=value;toggle.setAttribute('aria-expanded',String(!value));toggle.setAttribute('aria-label',value?qLangWorkspace.t('입력창 펼치기'):qLangWorkspace.t('입력창 접기'));localStorage.setItem('tmux-composer-collapsed',JSON.stringify(value));publishPanelState();updateTerminalViewport();if(follow)fitReaderTables();};
  toggle.addEventListener('click',()=>fold(!composerCollapsed));fold(composerCollapsed);
  for(const heading of [document.querySelector('.reader-view-controls'),document.querySelector('.terminal-heading')]){
    const select=element('select','','panel-pane-select');select.setAttribute('aria-label',qLangWorkspace.t('tmux 안의 화면 선택'));select.addEventListener('change',()=>{choosePane(select.value);if(mode==='terminal')connectTerminal();});heading.prepend(select);
  }
  document.addEventListener('pointerdown',()=>panelMessage({action:'focus'}),{capture:true,passive:true});
  $('message').addEventListener('input',publishPanelState);
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin||event.source!==parent||parent===window||!event.data?.tmuxSplit)return;
    const message=event.data;
    if(message.action==='visible'){
      const visible=message.visible===true;if(visible===panelVisible)return;panelVisible=visible;
      if(!visible){directInput.select();stopReader();detachTerminal();}else if(paneId){if(mode==='reader')startReader();else connectTerminal();}
    }
    if(message.action==='select'&&inventory.some(item=>item.id===message.session)){switchSession(message.session);if(['reader','terminal'].includes(message.view))setMode(message.view);}
    if(message.action==='view'&&['reader','terminal'].includes(message.view))setMode(message.view);
    if(message.action==='pane'&&selectedSession()?.panes.some(item=>item.id===message.pane))choosePane(message.pane);
    if(message.action==='zoom'&&['reader','terminal','sidebar','composer'].includes(message.region)&&[-1,0,1].includes(message.direction))viewZoom.step(message.region,message.direction);
  });
}
document.addEventListener('tmux-login-expired',showLogin);
// The reader's change label holds a localized time, so it is rebuilt in the new language.
let lastChangeLabel=null;
window.addEventListener('q-language-change',()=>{
  $('host-status').dataset.hosts='';
  if(lastChangeLabel)$('last-change').textContent=lastChangeLabel();
  if(splitWorkspace)splitWorkspace.list.dataset.signature='';
  if(!$('workspace').hidden){renderSessions();if(sessionId)renderTask();splitWorkspace?.update();notificationCenter.permissionUI();}
});
async function sendPane(payload,target=paneId){
  if(!target){notice(qLangWorkspace.t('입력할 화면을 선택하세요.'));return null;}
  const result=await api(`/api/panes/${encodeURIComponent(target)}/input`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,request_id:payload.request_id||crypto.randomUUID()})});
  if(!result.ok)throw new Error(result.error||qLangWorkspace.t('화면에서 전송 결과를 확인해 주세요.'));return result;
}
$('login-form').addEventListener('submit',async event=>{event.preventDefault();$('login-error').textContent='';try{await api('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:$('access-key').value.trim()})});$('access-key').value='';await showWorkspace();}catch(error){$('login-error').textContent=error.message;}});
$('refresh').addEventListener('click',()=>refreshSessions(true).catch(error=>notice(error.message)));
$('new-session').addEventListener('click',openNewSession);
if(splitWorkspace){const button=element('button',qLangWorkspace.t('새 세션 ＋'),'split-new-session');button.type='button';button.addEventListener('click',openNewSession);splitWorkspace.shell.querySelector('.split-add').before(button);}
$('new-session-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=$('new-session-submit');if(button.disabled)return;button.disabled=true;$('new-session-status').textContent=qLangWorkspace.t('만드는 중…');
  try{const data=await api('/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({host:$('new-session-host').value,name:$('new-session-name').value.trim(),path:$('new-session-path').value.trim()})});
    await refreshSessions();$('new-session-dialog').close();$('new-session-name').value='';$('new-session-path').value='';
    if(splitWorkspace)splitWorkspace.select(data.session.id,'terminal');else{openSession(data.session.id);setMode('terminal');}
  }catch(error){$('new-session-status').textContent=error.message;}finally{button.disabled=false;}
});
$('session-search').addEventListener('input',renderSessions);
$('sessions').addEventListener('change',event=>switchSession(event.target.value));$('all-sessions').addEventListener('click',showManager);
$('pin-current').addEventListener('click',()=>{if(selectedSession())togglePin(selectedSession());});
$('rename-current').addEventListener('click',()=>{const session=selectedSession();if(!session)return;const key=sessionKey(session),name=prompt(qLangWorkspace.t('이 폰에서 사용할 작업 별명'),aliases[key]||'');if(name===null)return;if(name.trim())aliases[key]=name.trim().slice(0,60);else delete aliases[key];savePreferences();renderSessions();renderTask();});
$('reader-mode').addEventListener('click',()=>setMode('reader'));$('terminal-mode').addEventListener('click',()=>setMode('terminal'));
$('reader-fullscreen').addEventListener('click',()=>setReaderExpanded(!readerExpanded));
$('reader-terminal').addEventListener('click',()=>setMode('terminal',true));
$('terminal-reader').addEventListener('click',()=>{setMode('reader');setReaderExpanded(true);});
$('reader-font').addEventListener('change',()=>{document.documentElement.style.setProperty('--reader-size',$('reader-font').value+'px');localStorage.setItem('tmux-reader-font-v2',$('reader-font').value);requestAnimationFrame(fitReaderTables);});
$('reader-scroll').addEventListener('scroll',()=>{if(readerZooming||panelRestoring)return;const area=$('reader-scroll');follow=area.scrollHeight-area.scrollTop-area.clientHeight<40;$('follow-output').textContent=follow?qLangWorkspace.t('최신 따라가기 ✓'):qLangWorkspace.t('최신 따라가기');$('follow-output').setAttribute('aria-pressed',String(follow));if(follow){$('new-output').hidden=true;if(pendingReader){const latest=pendingReader;pendingReader=null;renderOutput(latest.text,latest.ansi,false,latest.messages);}}else if(area.scrollTop<100)loadReaderHistory();});
$('load-history').addEventListener('click',loadReaderHistory);
let readerTouchY=0;
$('reader-scroll').addEventListener('touchstart',event=>{readerTouchY=event.touches[0]?.clientY||0;readerAutoLoads=0;},{passive:true});
$('reader-scroll').addEventListener('touchmove',event=>{if((event.touches[0]?.clientY||0)-readerTouchY>15&&$('reader-scroll').scrollTop<100)loadReaderHistory();},{passive:true});
$('reader-scroll').addEventListener('wheel',event=>{if(event.deltaY<0&&$('reader-scroll').scrollTop<100){readerAutoLoads=0;loadReaderHistory();}},{passive:true});
function followOutput(){follow=true;if(pendingReader){const latest=pendingReader;pendingReader=null;renderOutput(latest.text,latest.ansi,false,latest.messages);}$('reader-scroll').scrollTop=$('reader-scroll').scrollHeight;$('new-output').hidden=true;$('follow-output').textContent=qLangWorkspace.t('최신 따라가기 ✓');$('follow-output').setAttribute('aria-pressed','true');}
$('follow-output').addEventListener('click',followOutput);$('new-output').addEventListener('click',followOutput);
$('copy-output').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(readerText);notice(qLangWorkspace.t('출력을 복사했어요.'));}catch{notice(qLangWorkspace.t('복사 권한을 확인해 주세요.'));}});
$('fit-terminal').addEventListener('click',()=>{terminalTouch.reset();resize();});$('terminal-fullscreen').addEventListener('click',()=>setTerminalExpanded(!terminalExpanded));$('reconnect').addEventListener('click',connectTerminal);$('ctrl-toggle').addEventListener('click',()=>setCtrl(!ctrl));
document.querySelectorAll('[data-key]').forEach(button=>button.addEventListener('click',async()=>{try{if(mode==='terminal')rawInput(keyData[button.dataset.key]);else{await sendPane({type:'key',key:button.dataset.key});startReader();}}catch(error){notice(error.message);}}));
$('compose-form').addEventListener('submit',async event=>{
  event.preventDefault();if(directInput.enabled)return;if(phoneClient()&&event.submitter!==$('send-message'))return;
  const text=$('message').value,target=paneId,files=[...queuedAttachments(target)],submit=true;if((!text.trim()&&!files.length)||!target||pending)return;
  pending=true;$('send-message').disabled=true;renderAttachments();$('send-state').textContent=qLangWorkspace.t('전송 중');
  try{
    for(const [index,entry] of files.entries()){
      if(entry.uploaded)continue;if(target===paneId)$('send-state').textContent=qLangWorkspace.f("파일 {0}/{1}",[index+1,files.length]);
      const body=new FormData();body.append('file',entry.file,entry.file.name);
      entry.uploaded=await api(`/api/panes/${encodeURIComponent(target)}/attachments`,{method:'POST',body});
      if(target===paneId)renderAttachments();
    }
    const payload={type:'text',text,submit,attachments:files.map(entry=>entry.uploaded.id)},fingerprint=JSON.stringify(payload);
    let intent=sendIntents.get(target);if(!intent||intent.fingerprint!==fingerprint){intent={fingerprint,request_id:crypto.randomUUID()};sendIntents.set(target,intent);}
    if(target===paneId)$('send-state').textContent=qLangWorkspace.t('전송 중');
    await sendPane({...payload,request_id:intent.request_id},target);
    if(submit)deliveryPanel.submitted(target);
    sendIntents.delete(target);attachmentDrafts.set(target,queuedAttachments(target).filter(entry=>!files.includes(entry)));
    if(target===paneId){if($('message').value===text)$('message').value='';drafts.set(target,$('message').value);$('send-state').textContent=qLangWorkspace.t('보냄');setTimeout(()=>{if(target===paneId&&$('send-state').textContent===qLangWorkspace.t('보냄'))$('send-state').textContent='';},2500);fitComposerHeight();follow=true;renderAttachments();if(mode==='reader')startReader();}
    else if(drafts.get(target)===text)drafts.delete(target);
  }
  catch(error){if([401,403,404].includes(error.status))for(const entry of files)entry.uploaded=null;if(target===paneId)$('send-state').textContent=qLangWorkspace.t('전송 확인 필요');notice(error.message);}
  finally{pending=false;$('send-message').disabled=!selectedPane();renderAttachments();}
});
$('attach-files').addEventListener('click',()=>{$('attachment-files').value='';$('attachment-files').click();});
$('attachment-files').addEventListener('change',event=>{queueFiles(event.target.files);event.target.value='';});
$('message').addEventListener('paste',event=>{const files=event.clipboardData?.files;if(files?.length){event.preventDefault();queueFiles(files);}});
for(const type of ['dragenter','dragover'])$('task-view').addEventListener(type,event=>{if(Array.from(event.dataTransfer?.types||[]).includes('Files')){event.preventDefault();$('compose-form').classList.add('drag-over');}},true);
$('task-view').addEventListener('dragleave',event=>{if(!$('task-view').contains(event.relatedTarget))$('compose-form').classList.remove('drag-over');});
$('task-view').addEventListener('drop',event=>{if(!event.dataTransfer?.files?.length)return;event.preventDefault();event.stopPropagation();$('compose-form').classList.remove('drag-over');queueFiles(event.dataTransfer.files);},true);
$('task-view').addEventListener('paste',event=>{if(!event.clipboardData?.files?.length)return;event.preventDefault();event.stopPropagation();queueFiles(event.clipboardData.files);},true);
$('message').addEventListener('keydown',event=>{if(!phoneClient()&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();if(!event.repeat)$('compose-form').requestSubmit($('send-message'));}});
document.documentElement.classList.toggle('mobile-input',phoneClient());
if(phoneClient()){
  $('message').placeholder=qLangWorkspace.t('Enter 줄바꿈 · ↑ 보내기');$('message').setAttribute('enterkeyhint','enter');$('send-message').title=qLangWorkspace.t('메시지 보내기');
  $('message').addEventListener('input',fitComposerHeight);
  // Focus synchronously in the native tap, without cancelling caret placement,
  // selection, scrolling or the browser's keyboard activation.
  let tap=null;
  $('message').addEventListener('touchstart',event=>{const point=event.touches.length===1?event.touches[0]:null;tap=point?{x:point.clientX,y:point.clientY}:null},{passive:true});
  $('message').addEventListener('touchend',event=>{const point=event.changedTouches[0],start=tap;tap=null;
    if(start&&point&&!event.touches.length&&Math.hypot(point.clientX-start.x,point.clientY-start.y)<8&&document.activeElement!==$('message'))$('message').focus({preventScroll:true});
  },{passive:true});
  $('message').addEventListener('touchcancel',()=>tap=null,{passive:true});
}
window.addEventListener('resize',updateTerminalViewport);window.visualViewport?.addEventListener('resize',updateTerminalViewport);window.visualViewport?.addEventListener('scroll',updateTerminalViewport);
document.addEventListener('visibilitychange',()=>{if(document.hidden){stopReader();return;}if(!$('workspace').hidden){refreshSessions().catch(()=>{});if(sessionId){if(mode==='reader')startReader();else if(socket?.readyState!==WebSocket.OPEN)connectTerminal();}}});
async function init(){
 const generation=++startupGeneration;clearTimeout(startupTimer);const fragment=new URLSearchParams(location.hash.slice(1)),linkKey=fragment.get('key');if(fragment.has('key')){fragment.delete('key');history.replaceState(null,'',location.pathname+location.search+(fragment.size?'#'+fragment:''));$('access-key').value='';}
 // A link printed by `tmux-mobile start` signs in once; the key never stays in the address bar.
 if(linkKey)await api('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:linkKey})}).catch(()=>{});
 const waiting=$('workspace').hidden&&$('login-view').hidden;if(waiting)startup(true);const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
 try{await showWorkspace({signal:controller.signal});startupAttempt=0;}
 catch(error){if(generation!==startupGeneration)return;if([401,403].includes(error.status)){showLogin();startupAttempt=0;}else{if(waiting)startup(true);startupTimer=setTimeout(init,Math.min(1000*2**startupAttempt++,10000));}}
 finally{clearTimeout(timeout);}
}
const font=localStorage.getItem('tmux-reader-font-v2')||({'14':'12','16':'14','18':'16'}[localStorage.getItem('tmux-reader-font')])||'14';if(['12','14','16'].includes(font)){$('reader-font').value=font;document.documentElement.style.setProperty('--reader-size',font+'px');localStorage.setItem('tmux-reader-font-v2',font);}
function applyViewZoom(region,value,previous,point){
  if(region==='sidebar'){document.documentElement.style.setProperty('--sidebar-zoom',value);if(panelClient)panelMessage({action:'sidebarZoom',value});else splitWorkspace?.layout();return;}
  if(region==='terminal'){
    const rect=$('terminal-scroll').getBoundingClientRect();terminalTouch.zoomTo(value,point?{x:point.x-rect.left,y:point.y-rect.top}:undefined);return;
  }
  const area=$('reader-scroll'),anchor=readerAnchor(),before=area.scrollTop,height=area.scrollHeight,target=paneId;
  readerZooming=true;document.documentElement.style.setProperty('--'+region+'-zoom',region==='composer'?1:value);if(region==='composer'){fitComposerScale();fitComposerHeight();}
  TmuxReader.fitTables($('reader-content'));if(follow)area.scrollTop=area.scrollHeight;else restoreReaderAnchor(anchor,before,height);
  resize();requestAnimationFrame(()=>{if(target===paneId){TmuxReader.fitTables($('reader-content'));if(follow)area.scrollTop=area.scrollHeight;else restoreReaderAnchor(anchor,before,height);}readerZooming=false;});
}
viewZoom=new ViewZoom({apply:applyViewZoom,mode:()=>splitWorkspace?'sidebar':mode,enabled:()=>splitWorkspace?splitWorkspace.visible:!$('task-view').hidden&&!$('workspace').hidden,mobile:phoneClient,changed:publishPanelState});
for(const region of ['reader','sidebar','composer'])document.documentElement.style.setProperty('--'+region+'-zoom',region==='composer'?1:viewZoom.values[region]);
terminalTouch.zoom=terminalTouch.defaultZoom=viewZoom.values.terminal;
if(!panelClient){viewZoom.mount(document.querySelector('.reader-view-controls'));viewZoom.mount(document.querySelector('.terminal-heading'));}
if(!panelClient)notificationCenter.mount(document.querySelector('.app-header'));
window.addEventListener('hashchange',init);init();
