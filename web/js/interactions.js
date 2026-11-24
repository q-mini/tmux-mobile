const qLangInteractions=globalThis.QI18n||{t:value=>value,html:value=>value,f:(key,values)=>key.replace(/\{(\d+)\}/g,(_,index)=>String(values[index]??'')),locale:'ko-KR'};
/* Choices always describe the live pane. History and the shared draft stay intact. */
(function(root){
  'use strict';
  const node=(tag,text='',className='')=>{const result=document.createElement(tag);result.textContent=text;result.className=className;return result;};
  class QuestionPanel {
    constructor({area,fetch,send,notice,changed,context=()=>[]}){Object.assign(this,{area,fetch,send,notice,changed,context});this.generation=0;this.request=0;this.pending=new Set();this.answers=new Map();this.select('');}
    select(target){this.target=target;this.generation++;this.request++;this.frame=null;this.signature='';this.area.hidden=true;this.area.replaceChildren();}
    async poll(){
      const target=this.target,generation=this.generation,request=++this.request;if(!target||this.pending.has(target))return;
      try{const data=await this.fetch(`/api/panes/${encodeURIComponent(target)}/interaction`);
        if(target!==this.target||generation!==this.generation||request!==this.request)return;this.render(data.interaction);
      }catch{if(target===this.target&&generation===this.generation&&request===this.request)this.render(null);}
    }
    render(frame){
      if(frame){
        const normalized=text=>(text||'').replace(/\s+/g,' ').trim();
        const questions=this.context().flatMap(item=>item.question?.questions||[]);
        const question=[...questions].reverse().find(q=>normalized(q.prompt)===normalized(frame.title)&&q.options.every(option=>frame.options.some(item=>normalized(item.label)===normalized(option.label))));
        if(question)frame={...frame,options:frame.options.map(item=>{const rich=question.options.find(option=>normalized(option.label)===normalized(item.label));return rich?{...item,description:rich.description||item.description,preview:rich.preview}:item})};
      }
      const signature=JSON.stringify(frame);if(signature===this.signature)return;
      const collapsed=this.area.querySelector('details')?.open===false,sameQuestion=this.frame?.title===frame?.title;
      const descriptions=!sameQuestion||this.area.querySelector('.question-description-toggle')?.getAttribute('aria-expanded')!=='false';
      const answerKey=this.target+':'+frame?.title,editing=sameQuestion&&this.area.querySelector('.question-answer')?.hidden===false;
      const focused=sameQuestion&&document.activeElement===this.area.querySelector('.question-answer textarea'),selection=focused?[document.activeElement.selectionStart,document.activeElement.selectionEnd]:null;
      const scroll=sameQuestion?(this.area.querySelector('.question-content')?.scrollTop||0):0;
      const previews=new Set(sameQuestion?[...this.area.querySelectorAll('.reader-question-preview[open]')].map(item=>item.dataset.readerKey):[]);
      this.frame=frame;this.signature=signature;this.area.hidden=!frame;if(!frame){this.area.replaceChildren();return;}
      const review=frame.kind==='review',details=node('details','','question-box');details.open=!(collapsed&&sameQuestion);details.classList.toggle('show-descriptions',descriptions);
      const summary=node('summary');summary.append(node('span',frame.permission_kind==='workspace'?qLangInteractions.t('폴더 신뢰 확인'):frame.purpose==='permission'?qLangInteractions.t('실행 승인 확인'):frame.purpose==='model'?qLangInteractions.t('모델·추론 수준 선택'):review?qLangInteractions.t('답변 확인'):frame.kind==='input'?qLangInteractions.t('답변 입력'):qLangInteractions.t('답변 선택'),'question-status'));
      const steps=frame.tabs.replace(/[←→☐☑☒✔✓]/g,' ').trim().split(/\s{2,}/).map(text=>text.trim()==='Submit'?qLangInteractions.t('확인'):text.trim()).filter(Boolean);
      summary.append(node('span',steps.join(' / ')||(frame.progress||'').replace(/^Question /,qLangInteractions.t('질문 '))||(frame.kind==='multi'?qLangInteractions.t('여러 개 선택'):frame.options.length?frame.options.length+qLangInteractions.t('개 선택지'):qLangInteractions.t('입력 대기')),'question-progress'));details.append(summary);
      const body=node('div','','question-body'),content=node('div','','question-content');
      if(frame.effort){
        const effort=node('div','','question-effort');effort.append(node('span',qLangInteractions.t('추론 수준')),node('strong',frame.effort.level));
        if(frame.effort.note)effort.append(node('small',frame.effort.note==='default'?qLangInteractions.t('기본값'):frame.effort.note));
        effort.setAttribute('aria-live','polite');body.append(effort);
      }
      if(frame.context){const request=node('details','','question-request');request.open=true;request.append(node('summary',qLangInteractions.t('요청 내용')),node('pre',frame.context,'question-review'));content.append(request);}
      if(!review&&frame.options.length&&frame.selected!==null){
        content.append(node('p',frame.title,'question-title'));
        const options=node('div','','question-options');
        frame.options.forEach((item,index)=>{
          const button=node('button','','question-option');button.type='button';button.dataset.choice=item.number;button.setAttribute('aria-current',String(index===frame.selected));
          if(frame.kind==='multi'){button.dataset.multiple='true';button.setAttribute('aria-pressed',String(item.checked));}
          const indicator=node('span','','question-index');indicator.setAttribute('aria-hidden','true');button.append(indicator,node('strong',item.label));
          if(item.description)button.append(node('small',item.description));button.addEventListener('click',()=>{if(item.number===frame.custom_choice){editor.hidden=false;confirm.textContent=qLangInteractions.t('답변 제출');textarea.focus();}else this.act({choice:item.number});});
          if(item.preview){const row=node('div','','question-option-row');row.append(button,TmuxReader.questionPreview(item.preview,'live:'+frame.title+':'+item.number));options.append(row);}else options.append(button);
        });content.append(options);
        if(frame.overflow)content.append(node('p',frame.overflow+qLangInteractions.t(' · ↑↓로 더 보기'),'question-model-overflow'));
      }else{
        if(review)content.append(node('p',qLangInteractions.t('선택한 답변을 확인해 주세요.'),'question-title'));
        const text=frame.text.split('\n').filter(line=>line.trim()!==frame.tabs&&!/^(?:Review your answers|Ready to submit your answers\?)$/.test(line.trim())&&!(review&&/^\s*[❯›>]?\s*\d+[.)]\s+(?:Submit answers|Cancel)\s*$/.test(line))).map(line=>line.replace(/^\s*[│┃]\s*/, '')).join('\n').trim();
        content.append(node('pre',text,'question-review'));
      }
      const editor=node('div','','question-answer'),label=node('label',qLangInteractions.t('직접 답변')),textarea=node('textarea');
      editor.hidden=!(frame.kind==='input'||editing);textarea.placeholder=qLangInteractions.t('답변을 입력하세요…');textarea.rows=3;textarea.value=this.answers.get(answerKey)||'';label.append(textarea);editor.append(label,node('small',qLangInteractions.t('Enter 제출 · Shift+Enter 줄바꿈')));
      textarea.addEventListener('input',()=>this.answers.set(answerKey,textarea.value));
      const submitAnswer=async()=>{const answer=textarea.value;if(!answer.trim()){textarea.focus();return;}if(await this.act({answer})){this.answers.delete(answerKey);}};
      textarea.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();event.stopPropagation();submitAnswer();}});
      if(frame.custom_choice!==undefined||frame.kind==='input')content.append(editor);
      const controls=node('div','','question-navigation'),navigation=node('div','','question-nav-group'),confirmation=node('div','','question-nav-group');
      const add=(parent,label,key,action={key},className='quiet')=>{const button=node('button',label,className);button.type='button';button.dataset.questionKey=key;button.addEventListener('click',()=>this.act(action));parent.append(button);return button;};
      const actions=/Submit/.test(frame.tabs)?[[qLangInteractions.t('← 이전 질문'),'left'],[qLangInteractions.t('다음 질문 →'),'right']]:[];
      for(const [label,key] of actions){const button=add(navigation,key==='left'?qLangInteractions.t('이전'):qLangInteractions.t('다음'),key);button.setAttribute('aria-label',label.replace(/[←→]/g,'').trim());}
      if(frame.chat_choice!==undefined)add(navigation,qLangInteractions.t('질문에 대해 대화'),'chat',{choice:frame.chat_choice});
      if(!review&&frame.navigation_axis!=='horizontal'&&(frame.purpose==='model'||frame.selected===null||!frame.options.length)){add(navigation,'↑','up');add(navigation,'↓','down');}
      if(frame.purpose==='model'&&(frame.effort?.adjustable||/effort.*←|←.*effort/i.test(frame.text))){add(navigation,qLangInteractions.t('추론 −'),'left');add(navigation,qLangInteractions.t('추론 +'),'right');}
      if(frame.toggle){const toggle=add(navigation,frame.toggle.label+' '+(frame.toggle.value?'On':'Off'),frame.toggle.key);toggle.setAttribute('aria-pressed',String(frame.toggle.value));}
      if(!review&&frame.options.some(item=>item.description)){
        const button=node('button',qLangInteractions.t('설명'),'quiet question-description-toggle');button.type='button';button.setAttribute('aria-expanded',String(descriptions));button.setAttribute('aria-label',descriptions?qLangInteractions.t('선택지 설명 접기'):qLangInteractions.t('선택지 설명 보기'));
        button.addEventListener('click',()=>{const open=!details.classList.contains('show-descriptions');details.classList.toggle('show-descriptions',open);button.setAttribute('aria-expanded',String(open));button.setAttribute('aria-label',open?qLangInteractions.t('선택지 설명 접기'):qLangInteractions.t('선택지 설명 보기'));});navigation.append(button);
      }
      const submit=review&&frame.options.find(item=>/^Submit answers$/i.test(item.label)),cancel=review&&frame.options.find(item=>/^Cancel$/i.test(item.label));
      add(confirmation,qLangInteractions.t('취소'),'escape',cancel?{choice:cancel.number}:{key:'escape'});
      const confirm=add(confirmation,frame.kind==='multi'?qLangInteractions.t('선택 완료'):review||frame.selected===null||editing?qLangInteractions.t('답변 제출'):qLangInteractions.t('선택'),'enter',submit?{choice:submit.number}:frame.purpose==='model'&&frame.selected!==null?{choice:frame.options[frame.selected].number}:{key:'enter'},'question-confirm');
      confirm.addEventListener('click',event=>{if(!editor.hidden){event.stopImmediatePropagation();submitAnswer();}},true);
      controls.append(navigation,confirmation);body.append(content,controls);details.append(body);this.area.replaceChildren(details);
      for(const preview of this.area.querySelectorAll('.reader-question-preview'))if(previews.has(preview.dataset.readerKey))preview.open=true;
      details.addEventListener('toggle',()=>requestAnimationFrame(()=>TmuxReader.fitTables(this.area)),true);
      content.scrollTop=scroll;TmuxReader?.fitTables(this.area);this.disable();if(focused){textarea.focus({preventScroll:true});textarea.setSelectionRange(...selection);}
    }
    disable(){const pending=this.pending.has(this.target);this.area.setAttribute('aria-busy',String(pending));for(const button of this.area.querySelectorAll('button,textarea'))button.disabled=pending;}
    async act(action){
      const target=this.target,frame=this.frame;if(!target||!frame||this.pending.has(target))return;
      this.pending.add(target);this.request++;this.disable();
      try{await this.send({type:'interaction',token:frame.token,...action,request_id:crypto.randomUUID()},target);return true;}
      catch(error){this.notice(error.message);}
      finally{this.pending.delete(target);if(this.target===target){this.disable();await this.poll();this.changed?.();}}
    }
  }
  root.QuestionPanel=QuestionPanel;
})(globalThis);
