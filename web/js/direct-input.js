const qLangDirectInput=globalThis.QI18n||{t:value=>value,html:value=>value,f:(key,values)=>key.replace(/\{(\d+)\}/g,(_,index)=>String(values[index]??'')),locale:'ko-KR'};
/* A separate keyboard keeps the message draft intact. Every write is pane-scoped. */
(function(root){
  'use strict';
  class DirectInput {
    constructor({form,message,send,target,notice,changed}){
      Object.assign(this,{form,send,target,notice,changed});this.enabled=false;this.ctrl=false;this.shift=false;this.queue=Promise.resolve();this.epoch=0;
      const heading=document.createElement('div');heading.className='compose-heading';const label=form.querySelector('#input-target');label.replaceWith(heading);heading.append(label);
      const modes=document.createElement('div');modes.className='compose-mode-switch';modes.setAttribute('role','group');modes.setAttribute('aria-label',qLangDirectInput.t('입력 방식'));
      this.messageMode=document.createElement('button');this.messageMode.type='button';this.messageMode.className='compose-message-mode';this.messageMode.textContent=qLangDirectInput.t('메시지');this.messageMode.setAttribute('aria-label',qLangDirectInput.t('메시지 작성'));this.messageMode.setAttribute('aria-pressed','true');
      this.toggle=document.createElement('button');this.toggle.type='button';this.toggle.className='direct-toggle';this.toggle.innerHTML=qLangDirectInput.html('<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2" y="4" width="16" height="12" rx="2"/><path d="M5 8h1m3 0h1m3 0h1M5 11h1m3 0h1m3 0h1m-8 3h6"/></svg><span>키보드</span>');this.toggle.setAttribute('aria-label',qLangDirectInput.t('키보드 조작'));this.toggle.title=qLangDirectInput.t('키보드 조작 · 누르는 즉시 터미널에 전달');this.toggle.setAttribute('aria-pressed','false');modes.append(this.messageMode,this.toggle);heading.append(modes);
      this.box=document.createElement('div');this.box.className='direct-keyboard';this.box.hidden=true;
      this.box.innerHTML=qLangDirectInput.html('<p>키를 누르면 바로 입력돼요</p><nav aria-label="터미널 키보드"></nav><textarea rows="1" aria-label="직접 키보드 입력" placeholder="한글·기기 키보드로 입력" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="enter"></textarea>');
      this.input=this.box.querySelector('textarea');const bar=this.box.querySelector('nav');
      const characters=text=>Array.from(text,char=>[char.toUpperCase(),char]);
      const rows=[
        [['Esc','\x1b'],...characters('1234567890-='),['⌫','\x7f',1.5]],
        [['Tab','\t',1.5],...characters('qwertyuiop[]\\')],
        [['Ctrl',null,1.5],...characters("asdfghjkl;'"),['Enter','\r',2]],
        [['Shift',null,2],...characters('zxcvbnm,./'),['↑','\x1b[A',1.5]],
        [['Home','\x1b[H',1.5],['End','\x1b[F',1.5],['Space',' ',6],['←','\x1b[D'],['↓','\x1b[B'],['→','\x1b[C'],['Del','\x1b[3~',1.5]]
      ];
      rows.forEach(keys=>{const row=document.createElement('div');row.className='direct-key-row';keys.forEach(([label,data,width=1])=>{const button=document.createElement('button');button.type='button';button.textContent=label;button.style.setProperty('--key-width',width);button.dataset.key=label;button.setAttribute('aria-label',({'⌫':'Backspace','↑':qLangDirectInput.t('위쪽 화살표'),'↓':qLangDirectInput.t('아래쪽 화살표'),'←':qLangDirectInput.t('왼쪽 화살표'),'→':qLangDirectInput.t('오른쪽 화살표'),Space:qLangDirectInput.t('Space 공백')})[label]||label);
        if(label==='Ctrl'){this.ctrlButton=button;button.setAttribute('aria-pressed','false');}if(label==='Shift'){this.shiftButton=button;button.setAttribute('aria-pressed','false');}
        button.addEventListener('pointerdown',event=>event.preventDefault());
        button.addEventListener('click',()=>{if(label==='Ctrl')this.setCtrl(!this.ctrl);else if(label==='Shift')this.setShift(!this.shift);else this.write(this.shift?this.shifted(data):data);this.focusHardware();});row.append(button);
      });bar.append(row);});
      message.before(this.box);
      this.messageFrame=document.createElement('div');this.messageFrame.className='message-surface';message.before(this.messageFrame);this.messageFrame.append(message);message.wrap='soft';
      this.message=message;this.actions=form.querySelector('.compose-actions');this.attachments=form.querySelector('.attachment-list');
      this.toggle.addEventListener('click',()=>{this.setEnabled(true);this.focusHardware();});
      this.messageMode.addEventListener('click',()=>{this.setEnabled(false);this.message.focus({preventScroll:true});});
      this.input.addEventListener('keydown',event=>{
        if(event.isComposing||event.keyCode===229)return;
        const special={Enter:'\r',Backspace:'\x7f',Delete:'\x1b[3~',Escape:'\x1b',Tab:event.shiftKey?'\x1b[Z':'\t',ArrowUp:'\x1b[A',ArrowDown:'\x1b[B',ArrowLeft:'\x1b[D',ArrowRight:'\x1b[C',Home:'\x1b[H',End:'\x1b[F',PageUp:'\x1b[5~',PageDown:'\x1b[6~'};
        if(event.ctrlKey&&event.key.length===1){event.preventDefault();this.write(this.control(event.key));}
        else if(special[event.key]){event.preventDefault();this.write(special[event.key]);}
      });
      this.input.addEventListener('beforeinput',event=>{if(event.isComposing)return;const key={deleteContentBackward:'\x7f',deleteContentForward:'\x1b[3~',insertLineBreak:'\r',insertParagraph:'\r'}[event.inputType];if(key){event.preventDefault();this.write(key);}});
      const commit=event=>{if(event.isComposing)return;const text=this.input.value;this.input.value='';if(text)this.write(text);};
      this.input.addEventListener('input',commit);this.input.addEventListener('compositionend',commit);
      this.input.addEventListener('paste',event=>{event.preventDefault();const text=event.clipboardData?.getData('text/plain');if(text)this.write(text);});
    }
    control(text){return text.replace(/[@A-Z[\\\]^_a-z?]/g,c=>c==='?'?'\x7f':String.fromCharCode(c.toUpperCase().charCodeAt(0)&31));}
    shifted(text){if(text.length!==1)return text;const plain="1234567890-=[]\\;',./",shifted='!@#$%^&*()_+{}|:"<>?',index=plain.indexOf(text);return index<0?text.toUpperCase():shifted[index];}
    focusHardware(){if(matchMedia('(hover:hover) and (pointer:fine)').matches)this.input.focus({preventScroll:true});}
    setCtrl(value){this.ctrl=value;this.ctrlButton.setAttribute('aria-pressed',String(value));}
    setShift(value){this.shift=value;this.shiftButton.setAttribute('aria-pressed',String(value));for(const button of this.box.querySelectorAll('[data-key]')){const key=button.dataset.key;if(key.length===1&&key!=='⌫'&&!/[↑↓←→]/.test(key))button.textContent=value?this.shifted(key.toLowerCase()):key;}}
    setEnabled(value){this.enabled=value;this.form.classList.toggle('is-keyboard',value);this.box.hidden=!value;this.message.hidden=value;this.messageFrame.hidden=value;this.actions.hidden=value;
      this.attachments?.classList.toggle('direct-hidden',value);this.toggle.setAttribute('aria-pressed',String(value));this.messageMode.setAttribute('aria-pressed',String(!value));this.setCtrl(false);this.setShift(false);if(!value){this.input.value='';this.input.blur();}this.changed?.();}
    select(){this.epoch++;this.setEnabled(false);}
    write(value){
      const target=this.target(),epoch=this.epoch;if(!this.enabled||!target)return;
      const text=this.ctrl?this.control(value):value;this.setCtrl(false);this.setShift(false);
      // UTF-8 chunks keep multibyte characters intact and stay below the API limit.
      const chunks=[];let chunk='',bytes=0;for(const char of text){const size=new TextEncoder().encode(char).length;if(bytes+size>4000){chunks.push(chunk);chunk='';bytes=0;}chunk+=char;bytes+=size;}if(chunk)chunks.push(chunk);
      this.queue=this.queue.then(async()=>{if(epoch!==this.epoch)return;for(const text of chunks)await this.send({type:'raw',text},target);this.changed?.();}).catch(error=>{if(epoch===this.epoch){this.epoch++;this.setEnabled(false);}this.notice(qLangDirectInput.t('직접 입력을 멈췄어요. ')+error.message);});
    }
  }
  root.DirectInput=DirectInput;
})(globalThis);
