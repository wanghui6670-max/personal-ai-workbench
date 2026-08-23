/* harness-nav-markdown.js — Markdown 渲染、GenUI 渲染、文本工具函数
 * 从 harness-navigator.js 拆分而来
 */
export const escapeHtml=window.WB.esc;

export function compact(value,max=280){const text=String(value??'').replace(/\s+/g,' ').trim();return text.length<=max?text:`${text.slice(0,max-1)}…`;}
export function formatTime(date){const d=new Date(date);const pad=n=>String(n).padStart(2,'0');return `${pad(d.getMonth()+1)}月${pad(d.getDate())}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;}
export function formatElapsed(ms){if(ms<1000)return `${ms}ms`;const s=ms/1000;return s<60?`${s.toFixed(1)}秒`:`${Math.floor(s/60)}分${Math.round(s%60)}秒`;}
export function formatTokens(n){if(n==null)return '—';if(n<1000)return `${n}`;if(n<1000000)return `${(n/1000).toFixed(1)}K`;return `${(n/1000000).toFixed(1)}M`;}

/* ─── Markdown 渲染器 ─── */
export function renderMarkdown(text){
  if(!text)return '';
  let html=escapeHtml(text);
  // 代码块 ```
  html=html.replace(/```(\w*)\n?([\s\S]*?)```/g,(m,lang,code)=>{
    return `<pre class="md-code-block"><code>${code.replace(/^\n/,'')}</code></pre>`;
  });
  // 行内代码
  html=html.replace(/`([^`]+)`/g,'<code class="md-inline-code">$1</code>');
  // 标题
  html=html.replace(/^### (.+)$/gm,'<h4 class="md-h4">$1</h4>');
  html=html.replace(/^## (.+)$/gm,'<h3 class="md-h3">$1</h3>');
  html=html.replace(/^# (.+)$/gm,'<h2 class="md-h2">$1</h2>');
  // 粗体和斜体
  html=html.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
  html=html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g,'<em>$1</em>');
  // 链接
  html=html.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener" class="md-link">$1</a>');
  // 无序列表
  const lines=html.split('\n');
  const result=[];
  let inList=false,inOrder=false;
  for(let line of lines){
    if(/^\s*[-*] (.+)/.test(line)){
      if(!inList){result.push('<ul class="md-list">');inList=true;}
      result.push(`<li>${line.replace(/^\s*[-*] /,'')}</li>`);
    }else if(/^\s*\d+\. (.+)/.test(line)){
      if(!inOrder){result.push('<ol class="md-list">');inOrder=true;}
      result.push(`<li>${line.replace(/^\s*\d+\. /,'')}</li>`);
    }else if(line.match(/^<pre|^<h[234]|^<div/)){
      if(inList){result.push('</ul>');inList=false;}
      if(inOrder){result.push('</ol>');inOrder=false;}
      result.push(line);
    }else if(line.trim()){
      if(inList){result.push('</ul>');inList=false;}
      if(inOrder){result.push('</ol>');inOrder=false;}
      result.push(`<p class="md-p">${line}</p>`);
    }
  }
  if(inList)result.push('</ul>');
  if(inOrder)result.push('</ol>');
  return result.join('');
}

/* ─── GenUI 渲染器 ─── */
export function renderGenUI(spec){
  if(!spec||typeof spec!=='object')return '';
  const title=spec.title?`<div class="genui-title">${escapeHtml(spec.title)}</div>`:'';
  let items='';
  if(Array.isArray(spec.items)){
    for(const item of spec.items){
      if(item.type==='callout'){
        items+=`<div class="genui-callout genui-${item.tone||'info'}"><strong>${escapeHtml(item.title||'')}</strong><p>${escapeHtml(item.content||'')}</p></div>`;
      }else if(item.type==='grid'){
        const cols=item.cols||3;
        let cells='';
        for(const c of(item.items||[])){
          if(c.type==='stat')cells+=`<div class="genui-stat"><span class="label">${escapeHtml(c.label||'')}</span><span class="value">${escapeHtml(c.value||'')}</span></div>`;
          else cells+=`<div class="genui-cell">${escapeHtml(String(c.content||c.value||''))}</div>`;
        }
        items+=`<div class="genui-grid" style="--genui-cols:${cols}">${cells}</div>`;
      }else if(item.type==='list'){
        let lis='';
        for(const li of(item.items||[]))lis+=`<div class="genui-list-item"><strong>${escapeHtml(li.title||'')}</strong><span>${escapeHtml(li.desc||'')}</span></div>`;
        items+=`<div class="genui-list">${lis}</div>`;
      }else if(item.type==='text'){
        items+=`<p class="genui-text">${escapeHtml(item.content||'')}</p>`;
      }
    }
  }
  return `<div class="genui-card">${title}<div class="genui-body" style="gap:${spec.gap||14}px">${items}</div></div>`;
}

export function extractGenUI(text){
  const blocks=[];
  const regex=/```dsh-ui\n([\s\S]*?)```/g;
  let match;
  while((match=regex.exec(text))!==null){
    try{blocks.push(JSON.parse(match[1].trim()));}catch{}
  }
  return blocks;
}
export function stripGenUI(text){
  return text.replace(/```dsh-ui\n[\s\S]*?```/g,'');
}
