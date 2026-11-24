/* Local text-only coloring for transcript code that has no terminal SGR data. */
(function(root){
 'use strict';
 const keywords=new Set('def class return if elif else for while in is not and or None True False import from as with try except finally raise pass break continue lambda async await yield function const let var new null undefined true false export default public private protected static void int float double char struct enum typedef auto bool namespace using template switch case throw catch proc set foreach puts source exit fi then do done esac echo'.split(' '));
 const tokens=/(#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\\[A-Za-z@]+\*?|\$[^$\n]*\$|\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b[A-Za-z_][\w]*\b)/g;
 function append(target,text,kind){if(!text)return;if(!kind){target.append(document.createTextNode(text));return;}const span=document.createElement('span');span.className='code-'+kind;span.textContent=text;target.append(span);}
 function paint(target,lines,appendOriginal,options={}){
  const source=lines.map(l=>l.text).join('\n'),latex=options.language==='LaTeX'||!options.language&&/\\(?:begin|end|label|ref|caption|textbf|section)\b/.test(source),diff=options.diff!==false&&/^(?:@@ |\*\*\* (?:Begin Patch|Update File)|[-+]\s*[^\n]+)/m.test(source);
  let budget=180000;
  lines.forEach((line,index)=>{
   if(index)target.append(document.createTextNode('\n'));
   const row=document.createElement('span');row.className='code-line';target.append(row);
   if(line.runs.some(run=>run.style.fg||run.style.bg||run.style.inverse)){appendOriginal(row,line);return;}
   const text=line.text;budget-=text.length;
   if(options.language==='Vim'&&/^\s*"/.test(text)){append(row,text,'comment');return;}
   if(budget<0){row.textContent=text;return;}
   const change=diff&&text.match(/^\s*(?:\d+\s*)?([+-])(?![+-])/);
   if(change)row.classList.add(change[1]==='+'?'code-add':'code-delete');
   if(/^@@ |^\*\*\* (?:Begin|End|Update|Add|Delete)/.test(text))row.classList.add('code-hunk');
   let offset=0;
   const commentAt=latex?text.search(/(?<!\\)%/):-1;
   const body=commentAt>=0?text.slice(0,commentAt):text;
   const pattern=latex?/\\[A-Za-z@]+\*?|\$[^$\n]*\$|\b\d+(?:\.\d+)?\b/g:tokens;
   for(const match of body.matchAll(pattern)){
    append(row,body.slice(offset,match.index));const value=match[0];
    const kind=/^(?:#|\/\/|\/\*)/.test(value)?'comment':/^["'`]/.test(value)?'string':/^\\/.test(value)?'command':/^\$/.test(value)?'math':/^\d/.test(value)?'number':keywords.has(value)?'keyword':/^\s*\(/.test(body.slice(match.index+value.length))?'function':'';
    append(row,value,kind);offset=match.index+value.length;
   }
   append(row,body.slice(offset));if(commentAt>=0)append(row,text.slice(commentAt),'comment');
  });
 }
 root.TmuxCode={paint};
})(globalThis);
