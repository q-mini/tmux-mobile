/* Saved conversations stay on their host. Only the selected page lives here. */
(function(root){
  'use strict';
  class ConversationReader {
    constructor(fetch){this.fetch=fetch;this.generation=0;this.select('');}
    select(target){this.target=target;this.generation++;this.supported=null;this.probed=0;this.session='';this.source='';this.version='';this.cursor='';this.items=new Map();this.changedAt=0;this.statusLines=[];this.usageStatus=null;this.cache=null;}
    async request(query){return this.fetch(`/api/panes/${encodeURIComponent(this.target)}/conversation?${new URLSearchParams(query)}`);}
    merge(data,older=false){
      let changed=false;
      if(data.reset||data.session_id!==this.session){this.items.clear();this.session=data.session_id;this.cursor=data.before||'';changed=true;}
      this.changedAt=data.changed_at||this.changedAt;
      for(const item of data.messages||[]){
        const old=this.items.get(item.id);if(older&&old)continue;
        if(!old||old.text!==item.text||old.title!==item.title||old.role!==item.role||JSON.stringify(old.attachments)!==JSON.stringify(item.attachments)||JSON.stringify(old.media)!==JSON.stringify(item.media)||JSON.stringify(old.question)!==JSON.stringify(item.question)||JSON.stringify(old.question_reply)!==JSON.stringify(item.question_reply)){this.items.set(item.id,{...item,offset:old?.offset??item.offset});changed=true;}
      }
      if(older)this.cursor=data.before||'';
      if(changed)this.cache=null;
      return changed;
    }
    state(changed){
      if(!this.cache){const sorted=[...this.items.values()].sort((a,b)=>a.offset-b.offset||a.block-b.block),messages=root.TmuxReader?.questionMessages(sorted)||sorted;
        const text=messages.map(item=>(item.role==='user'?'› ':item.speaker?item.speaker+'\n':item.role==='activity'?'• '+item.title+'\n':'')+(item.plain??item.text)).join('\n\n');this.cache={messages,text};}
      return{source:this.source,changed,...this.cache,history_more:!!this.cursor,changed_at:this.changedAt,status_lines:this.statusLines,usage_status:this.usageStatus};
    }
    async poll(force=false){
      if(!this.target||(this.supported===false&&!force&&Date.now()-this.probed<10000))return null;
      const generation=this.generation;this.probed=Date.now();let data;
      try{data=await this.request({version:this.version});}catch(error){if(error.status===404){this.supported=false;return null;}throw error;}
      if(generation!==this.generation)return null;
      if(data.source==='codex'&&data.status_only){this.supported=null;this.source='codex';return data;}
      if(!['claude','codex'].includes(data.source)){if(this.supported&&force)return this.state(false);this.supported=false;return null;}
      this.supported=true;this.source=data.source;this.version=data.version;
      this.statusLines=data.status_lines||[];
      this.usageStatus=data.usage_status||null;
      const changed=data.changed?this.merge(data):false;
      if(!this.items.size&&this.cursor)return await this.older();
      return this.state(changed);
    }
    async older(){
      const generation=this.generation;let changed=false;
      for(let page=0;page<4&&this.cursor;page++){
        const data=await this.request({before:this.cursor});if(generation!==this.generation)return null;
        if(data.source!==this.source)throw new Error('이 세션의 저장된 대화 기록을 다시 확인해 주세요.');
        const added=this.merge(data,true);changed=changed||added;
        if(added||!data.has_more)break;
      }
      return this.state(changed);
    }
  }
  root.ConversationReader=ConversationReader;
})(globalThis);
