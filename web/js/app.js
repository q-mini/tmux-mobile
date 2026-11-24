'use strict';
const $ = id => document.getElementById(id);
let terminal, socket, reconnectTimer, noticeTimer;
let connectedSession = '', reconnectAttempt = 0, ctrl = false, terminalReady = false;
const keys = {escape:'\x1b',tab:'\t',up:'\x1b[A',down:'\x1b[B',left:'\x1b[D',right:'\x1b[C',enter:'\r',interrupt:'\x03'};
document.querySelectorAll('[data-install]').forEach(button=>{
  button.hidden=window.matchMedia('(display-mode: standalone)').matches || !!navigator.standalone;
  button.addEventListener('click',()=>$('install-dialog').showModal());
});
function notice(message) { $('notice').textContent = message; $('notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $('notice').hidden = true, 5000); }
function status(message, live=false) { $('status-text').textContent = message; $('status-light').classList.toggle('connected',live); }
async function api(path, options={}) {
  const response = await fetch(path, {credentials:'same-origin',...options});
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') showLogin();
    throw new Error(await response.text());
  }
  return response.json();
}
function showLogin() {
  clearTimeout(reconnectTimer); connectedSession='';
  if (socket) { socket.onclose=null; socket.close(); socket=null; }
  $('workspace').hidden=true; $('login-view').hidden=false;
}
async function showWorkspace() {
  const data = await api('/api/sessions');
  $('login-view').hidden=true; $('workspace').hidden=false;
  if (!terminal) {
    terminal = new Terminal({cursorBlink:true,fontSize:13,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace',scrollback:3000,theme:{background:'#080d15',foreground:'#d6e1f0',cursor:'#80e5bb'},allowProposedApi:false});
    terminal.open($('terminal'));
    terminal.onData(data => { if (terminalReady) { sendInput(ctrl ? control(data) : data); if(ctrl)setCtrl(false); } });
    terminal.attachCustomKeyEventHandler(event => !(event.type === 'keydown' && event.key === 'Enter' && event.ctrlKey));
  }
  fillSessions(data.sessions);
  const remembered=localStorage.getItem('tmux-mobile-session');
  if (!connectedSession && data.sessions.some(item=>item.id===remembered)) { $('sessions').value=remembered; connect(remembered); }
}
function fillSessions(sessions) {
  const selected=connectedSession || $('sessions').value;
  $('sessions').replaceChildren(new Option(sessions.length ? '세션을 선택하세요' : '실행 중인 세션이 없어요',''));
  for(const item of sessions) $('sessions').append(new Option(`${item.name} · ${item.attached ? 'PC 연결됨' : '대기 중'}`, item.id));
  if(sessions.some(item=>item.id===selected)) $('sessions').value=selected;
}
function termSize() {
  const available=$('terminal-scroll');
  const cols=$('width').value === 'fit' ? Math.max(20,Math.floor((available.clientWidth-22)/7.83)) : Number($('width').value);
  const rows=Math.max(5,Math.min(100,Math.floor((available.clientHeight-22)/15)));
  return {cols,rows};
}
function resize() {
  if(!terminal)return;
  const size=termSize(); terminal.resize(size.cols,size.rows);
  if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'resize',...size}));
}
function connect(id, retry=false) {
  clearTimeout(reconnectTimer); terminalReady=false;
  if(socket){socket.onclose=null;socket.close();socket=null;}
  connectedSession=id;
  $('empty-state').hidden=!!id;
  if(!id){status('연결 대기');$('terminal-name').textContent='작업할 세션을 선택하세요';return;}
  localStorage.setItem('tmux-mobile-session',id);
  terminal.reset(); resize(); status(retry?'다시 연결 중…':'연결 중…');
  $('terminal-name').textContent=$('sessions').selectedOptions[0]?.textContent.split(' · ')[0] || 'tmux';
  const size=termSize();
  const url=new URL('/api/terminal',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
  url.search=new URLSearchParams({session:id,cols:size.cols,rows:size.rows});
  const active=new WebSocket(url);socket=active;active.binaryType='arraybuffer';
  active.onopen=()=>{if(socket!==active)return;terminalReady=true;reconnectAttempt=0;status('연결됨',true);};
  active.onmessage=event=>{if(socket===active && event.data instanceof ArrayBuffer)terminal.write(new Uint8Array(event.data));};
  active.onclose=event=>{
    if(socket!==active)return;
    terminalReady=false;status('연결 끊김');
    if(connectedSession && !document.hidden){
      const delay=Math.min(30000,1000*2**Math.min(reconnectAttempt++,5));
      reconnectTimer=setTimeout(async()=>{try{await api('/api/sessions');connect(connectedSession,true);}catch(error){notice(error.message);}},delay);
    }
  };
}
function control(data){return data.length===1 && /[a-zA-Z]/.test(data) ? String.fromCharCode(data.toUpperCase().charCodeAt(0)-64):data;}
function setCtrl(value){ctrl=value;$('ctrl-toggle').setAttribute('aria-pressed',String(value));}
function sendInput(data){
  if(!terminalReady || socket?.readyState!==WebSocket.OPEN){notice('먼저 세션에 연결해 주세요.');return false;}
  socket.send(JSON.stringify({type:'input',data}));return true;
}
$('login-form').addEventListener('submit',async event=>{
  event.preventDefault();$('login-error').textContent='';
  try {await api('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:$('access-key').value.trim()})});$('access-key').value='';await showWorkspace();}
  catch(error){$('login-error').textContent=error.message;}
});
$('sessions').addEventListener('change',event=>connect(event.target.value));
$('refresh').addEventListener('click',async()=>{try{fillSessions((await api('/api/sessions')).sessions);}catch(error){notice(error.message);}});
$('reconnect').addEventListener('click',()=>connect($('sessions').value));
$('width').addEventListener('change',resize);
$('ctrl-toggle').addEventListener('click',()=>setCtrl(!ctrl));
document.querySelectorAll('[data-key]').forEach(button=>button.addEventListener('click',()=>sendInput(keys[button.dataset.key])));
$('compose-form').addEventListener('submit',event=>{
  event.preventDefault();const message=$('message').value;
  if(!message)return;
  if(!terminalReady || socket?.readyState!==WebSocket.OPEN){notice('먼저 세션에 연결해 주세요.');return;}
  // xterm honors whether the connected TUI has enabled bracketed paste.
  terminal.paste(message.replaceAll('\x1b',''));
  sendInput('\r');
  $('message').value='';
});
$('message').addEventListener('keydown',event=>{if(event.key==='Enter' && (event.ctrlKey||event.metaKey)){event.preventDefault();$('compose-form').requestSubmit();}});
window.addEventListener('resize',()=>requestAnimationFrame(resize));
document.addEventListener('visibilitychange',()=>{if(!document.hidden && connectedSession && socket?.readyState!==WebSocket.OPEN)connect(connectedSession,true);});
async function init(){
  const fragment=new URLSearchParams(location.hash.slice(1));const key=fragment.get('key');
  if(key){history.replaceState(null,'',location.pathname);$('access-key').value='';}
  try{await showWorkspace();}catch(error){showLogin();}
}
window.addEventListener('hashchange',init);
init();
