window.__ModuleLoader__.load({id:`@nmg/dsh-nmg`,factory:e=>{var t={exports:{}},n=t.exports;Object.defineProperty(n,Symbol.toStringTag,{value:`Module`});var r=Object.create,i=Object.defineProperty,a=Object.getOwnPropertyDescriptor,o=Object.getOwnPropertyNames,s=Object.getPrototypeOf,c=Object.prototype.hasOwnProperty,l=(e,t,n,r)=>{if(t&&typeof t==`object`||typeof t==`function`)for(var s=o(t),l=0,u=s.length,d;l<u;l++)d=s[l],!c.call(e,d)&&d!==n&&i(e,d,{get:(e=>t[e]).bind(null,d),enumerable:!(r=a(t,d))||r.enumerable});return e},u=(e,t,n)=>(n=e==null?{}:r(s(e)),l(t||!e||!e.__esModule||!c.call(e,`default`)?i(n,`default`,{value:e,enumerable:!0}):n,e));let d=e("react");d=u(d,1);let f=`nmg-toolview-css`;function p(){let e=!1;return(()=>{if(e||typeof document>`u`||document.querySelector(`style[data-plugin-css=`+JSON.stringify(f)+`]`))return;let t=document.createElement(`style`);t.dataset.plugin=`@nmg/dsh-nmg`,t.dataset.pluginCss=f,t.textContent=`
  .nmg-tool-card {
    display: block;
    margin: 6px 0;
    padding: 8px 12px;
    border: 1px solid var(--nmg-border, rgba(127,127,127,.35));
    border-left: 3px solid var(--nmg-accent, #2563eb);
    border-radius: 8px;
    background: var(--nmg-surface, rgba(0,0,0,.04));
    color: var(--nmg-text, #111827);
    font-size: 12px;
    line-height: 1.5;
    min-width: 0;
    contain: content;
  }
  .nmg-tool-card-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }
  .nmg-tool-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--nmg-accent, #2563eb);
    color: #ffffff;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: .5px;
    line-height: 1.4;
  }
  .nmg-tool-name {
    font-weight: 600;
    font-family: monospace;
    color: var(--nmg-text, #111827);
  }
  .nmg-tool-state {
    margin-left: auto;
    font-size: 10px;
    text-transform: uppercase;
    opacity: .75;
    color: var(--nmg-text-dim, #6b7280);
  }
  .nmg-tool-label {
    font-weight: 500;
    color: var(--nmg-text, #111827);
    margin-bottom: 4px;
    word-break: break-word;
  }
  .nmg-tool-result {
    margin: 0;
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--nmg-surface-2, rgba(0,0,0,.05));
    color: var(--nmg-text-2, #374151);
    font-family: monospace;
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 180px;
    overflow: auto;
  }
  .nmg-tool-running {
    font-size: 11px;
    opacity: .6;
    color: var(--nmg-text-dim, #6b7280);
  }
  .nmg-tool-error .nmg-tool-label {
    color: #dc2626;
  }
  .nmg-recall-pill {
    position: fixed;
    z-index: 9999;
    min-width: 0;
    max-width: 92vw;
    pointer-events: auto; /* shell.overlay is click-through; the pill opts back in */
    border: 1px solid var(--nmg-border, rgba(127,127,127,.35));
    border-left: 3px solid var(--nmg-accent, #2563eb);
    border-radius: 10px;
    background: var(--nmg-surface, rgba(0,0,0,.9));
    color: var(--nmg-text, #111827);
    font-size: 12px;
    line-height: 1.4;
    box-shadow: 0 4px 16px rgba(0,0,0,.28);
    overflow: hidden;
    user-select: none;
    touch-action: none;
  }
  /* collapsed: no fixed layout, sized by inline width:auto → wraps its content */
  .nmg-recall-pill-collapsed {
    width: fit-content;
  }
  /* expanded: a proper window filling its inline width/height; body scrolls */
  .nmg-recall-pill-expanded {
    display: flex;
    flex-direction: column;
  }
  .nmg-recall-pill-expanded .nmg-recall-pill-body {
    flex: 1;
    overflow: auto;
    cursor: text;
    user-select: text;
  }
  .nmg-recall-pill-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    cursor: move;
    flex: none;
  }
  .nmg-recall-pill .nmg-tool-badge {
    flex: none;
  }
  .nmg-recall-dock-state {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--nmg-text, #111827);
  }
  .nmg-recall-pill-toggle,
  .nmg-recall-pill-close {
    flex: none;
    border: none;
    background: transparent;
    color: var(--nmg-text-dim, #6b7280);
    font-size: 12px;
    cursor: pointer;
    padding: 0 3px;
    line-height: 1;
  }
  .nmg-recall-pill-toggle:hover,
  .nmg-recall-pill-close:hover {
    color: var(--nmg-text, #111827);
  }
  .nmg-recall-pill-body {
    padding: 6px 10px 8px;
    border-top: 1px solid var(--nmg-border, rgba(127,127,127,.25));
    cursor: text;
    user-select: text;
  }
  .nmg-recall-pill-meta {
    font-family: monospace;
    font-size: 10px;
    color: var(--nmg-text-dim, #6b7280);
    word-break: break-all;
    margin-bottom: 3px;
  }
  .nmg-recall-pill-preview {
    color: var(--nmg-text-2, #374151);
    word-break: break-word;
  }
  .nmg-recall-pill-card {
    padding: 4px 0;
    border-bottom: 1px solid var(--nmg-border, rgba(127,127,127,.18));
  }
  .nmg-recall-pill-card:last-of-type {
    border-bottom: none;
  }
  .nmg-recall-pill-nav {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
  }
  .nmg-recall-pill-navbtn {
    border: 1px solid var(--nmg-border, rgba(127,127,127,.35));
    background: transparent;
    color: var(--nmg-text, #111827);
    border-radius: 6px;
    font-size: 11px;
    padding: 2px 8px;
    cursor: pointer;
  }
  .nmg-recall-pill-navbtn:disabled {
    opacity: .4;
    cursor: default;
  }
  .nmg-recall-pill-navbtn:hover:not(:disabled) {
    background: var(--nmg-surface-2, rgba(0,0,0,.06));
  }
  .nmg-recall-pill-resize {
    position: absolute;
    right: 2px;
    bottom: 2px;
    width: 14px;
    height: 14px;
    cursor: nwse-resize;
    opacity: .5;
    background: linear-gradient(135deg, transparent 0 60%, var(--nmg-text-dim, #6b7280) 60% 75%, transparent 75%);
  }
  .nmg-recall-pill-resize:hover {
    opacity: .9;
  }
`,document.head.appendChild(t)})(),()=>{if(e||typeof document>`u`)return;e=!0;let t=document.querySelector(`style[data-plugin-css=`+JSON.stringify(f)+`]`);t&&t.parentNode&&t.parentNode.removeChild(t)}}let m={nmg_search:`#2563eb`,nmg_get:`#0ea5e9`,nmg_remember:`#16a34a`,nmg_board:`#9333ea`,nmg_daemon:`#d97706`},h={"--nmg-text":`#111827`,"--nmg-text-2":`#374151`,"--nmg-text-dim":`#6b7280`,"--nmg-surface":`rgba(0, 0, 0, .04)`,"--nmg-surface-2":`rgba(0, 0, 0, .06)`,"--nmg-border":`rgba(127, 127, 127, .35)`},g={"--nmg-text":`#e5e7eb`,"--nmg-text-2":`#d1d5db`,"--nmg-text-dim":`#9ca3af`,"--nmg-surface":`rgba(255, 255, 255, .07)`,"--nmg-surface-2":`rgba(255, 255, 255, .11)`,"--nmg-border":`rgba(255, 255, 255, .22)`},_=[`nmg_search`,`nmg_get`,`nmg_remember`,`nmg_board`,`nmg_daemon`];function v(e){return(Array.isArray(e)?e:[]).map(e=>e&&e.type===`text`?e.text:``).join(``).replace(/\s+/g,` `).trim()}function y(e){try{let t=JSON.parse(String(e||`{}`));return t&&typeof t==`object`&&!Array.isArray(t)?t:{}}catch{return{}}}function b(e,t){switch(e){case`nmg_search`:return String(t.query||``);case`nmg_get`:return(Array.isArray(t.memoryIds)?t.memoryIds:[]).join(`, `);case`nmg_remember`:return String(t.statement||``)+(t.nodeName?`  →  `+String(t.nodeName):``);case`nmg_board`:return String(t.action||``)+(t.taskId?`  `+String(t.taskId):``);case`nmg_daemon`:return String(t.action||``);default:return``}}function x(e){return e.length<=420?e:e.slice(0,419)+`…`}function S(e){let t=e.block,n=!!(t&&t.kind===`tool-result`),r=e.toolName||t&&(t.name||t.call&&t.call.name)||`nmg`,i=n?t.call?t.call.argsRaw:``:t?t.argsRaw:``,a=d.default.useMemo(()=>y(i),[i]),o=d.default.useMemo(()=>n?v(t.content):``,[n,t]),s=n?!!t.isError:!1,c=m[r]||(e.nmgDark?`#818cf8`:`#6b7280`),l=b(r,a),u=e.nmgDark?g:h;return d.default.createElement(`div`,{className:`nmg-tool-card`+(s?` nmg-tool-error`:``),style:Object.assign({"--nmg-accent":c},u)},d.default.createElement(`div`,{className:`nmg-tool-card-head`},d.default.createElement(`span`,{className:`nmg-tool-badge`},`NMG`),d.default.createElement(`span`,{className:`nmg-tool-name`},r),d.default.createElement(`span`,{className:`nmg-tool-state`},n?s?`error`:`done`:`running`)),l?d.default.createElement(`div`,{className:`nmg-tool-label`},l):null,n?o?d.default.createElement(`pre`,{className:`nmg-tool-result`},x(o)):null:d.default.createElement(`div`,{className:`nmg-tool-running`},`running…`))}let C=d.default.memo(S,(e,t)=>e.callId===t.callId&&e.toolName===t.toolName&&e.block===t.block&&e.nmgDark===t.nmgDark),w=[`slots`,`theme`];function T(e){let t=e.theme,n=new Set,r=`light`,i=()=>{try{let e=t.getTheme();r=e&&e.active&&e.active.colorScheme===`dark`?`dark`:`light`}catch{r=`light`}n.forEach(e=>e())};i();function a(){let[e,t]=d.default.useState(r);return d.default.useEffect(()=>{let e=()=>t(r);return n.add(e),()=>{n.delete(e)}},[]),e}function o(e){let t=a()===`dark`;return d.default.createElement(C,Object.assign({},e,{nmgDark:t}))}let s=`nmg.recall.pill`,c=`nmg.recall.window`;function l(){return{left:window.innerWidth-280,top:80,width:0,height:0}}function u(){return{left:window.innerWidth-420,top:96,width:380,height:300}}function f(e,t){try{let n=window.localStorage.getItem(e);if(!n)return t();let r=JSON.parse(n);if(!r||typeof r!=`object`)return t();let i=t();return{left:typeof r.left==`number`?r.left:i.left,top:typeof r.top==`number`?r.top:i.top,width:typeof r.width==`number`?r.width:i.width,height:typeof r.height==`number`?r.height:i.height}}catch{return t()}}function m(e,t){try{window.localStorage.setItem(e,JSON.stringify(t))}catch{}}function v(e){let t=a()===`dark`,n=e.useSessions(e=>e&&e.current),[r,i]=d.default.useState(null),[o,p]=d.default.useState(!1),[_,v]=d.default.useState(!1),[y,b]=d.default.useState(()=>typeof window>`u`?{left:20,top:80,width:0,height:0}:f(s,l)),[x,S]=d.default.useState(()=>typeof window>`u`?{left:20,top:96,width:380,height:300}:f(c,u)),C=d.default.useRef(null),[w,T]=d.default.useState(0);d.default.useEffect(()=>{if(!n){i(null);return}let e=!0,t=()=>{fetch(`/nmg/recall?session=`+encodeURIComponent(n),{headers:{accept:`application/json`}}).then(e=>e.ok?e.json():null).then(t=>{e&&(t&&t.ok?i(t.data||null):i(null))}).catch(()=>{})};t();let r=window.setInterval(t,5e3);return()=>{e=!1,window.clearInterval(r)}},[n]);let E=o?x:y,D=o?S:b,O=o?c:s,k=d.default.useCallback((e,t)=>{if(e.button!==0)return;e.preventDefault();let n={...E};C.current={mode:t,startX:e.clientX,startY:e.clientY,base:n,key:O,set:D};let r=e=>{let t=C.current;if(!t)return;let n=e.clientX-t.startX,r=e.clientY-t.startY;t.mode===`move`?t.set(e=>({left:Math.max(0,t.base.left+n),top:Math.max(0,t.base.top+r),width:e.width,height:e.height})):t.set(e=>({left:e.left,top:e.top,width:Math.max(260,t.base.width+n),height:Math.max(120,t.base.height+r)}))},i=e=>{window.removeEventListener(`pointermove`,r),window.removeEventListener(`pointerup`,i);let t=C.current;if(t){let n=e.clientX-t.startX,r=e.clientY-t.startY,i=t.mode===`move`?{left:Math.max(0,t.base.left+n),top:Math.max(0,t.base.top+r),width:t.base.width,height:t.base.height}:{left:t.base.left,top:t.base.top,width:Math.max(260,t.base.width+n),height:Math.max(120,t.base.height+r)};m(t.key,i)}C.current=null};window.addEventListener(`pointermove`,r),window.addEventListener(`pointerup`,i)},[o,E,O,D]),A=()=>{let e=!o;m(o?c:s,o?x:y),p(e)},j=r&&Array.isArray(r.recalls)?r.recalls:[],M=j.length>0;if(_)return null;d.default.useEffect(()=>{T(0)},[M]);let N=t?g:h,P=Math.min(w,Math.max(0,j.length-1)),F=M?j[P]:null,I=M?`召回 `+(j[0].candidates?j[0].candidates.length:0)+` 条 · 最近 ~`+(j[0].tokens==null?`?`:j[0].tokens)+` token · 共 `+j.length+` 轮`+(P>0?` (#`+(P+1)+`)`:``):`当前会话暂无召回`,L=Object.assign({"--nmg-accent":`#2563eb`,left:E.left,top:E.top},o?{width:x.width,height:x.height}:{width:`auto`,minWidth:120},N);return d.default.createElement(`div`,{className:`nmg-recall-pill`+(o?` nmg-recall-pill-expanded`:` nmg-recall-pill-collapsed`),style:L},d.default.createElement(`div`,{className:`nmg-recall-pill-head`,style:{cursor:`move`},onPointerDown:e=>{e.button===0&&k(e,`move`)}},d.default.createElement(`span`,{className:`nmg-tool-badge`},`NMG`),d.default.createElement(`span`,{className:`nmg-recall-dock-state`},I),d.default.createElement(`button`,{type:`button`,className:`nmg-recall-pill-toggle`,"aria-label":o?`收起`:`展开`,onPointerDown:e=>e.stopPropagation(),onClick:e=>{e.stopPropagation(),A()}},o?`▾`:`▸`),d.default.createElement(`button`,{type:`button`,className:`nmg-recall-pill-close`,"aria-label":`隐藏`,onPointerDown:e=>e.stopPropagation(),onClick:e=>{e.stopPropagation(),v(!0)}},`✕`)),o&&F?d.default.createElement(`div`,{className:`nmg-recall-pill-body`},(F.candidates||[]).map((e,t)=>d.default.createElement(`div`,{key:e.id||t,className:`nmg-recall-pill-card`},d.default.createElement(`div`,{className:`nmg-recall-pill-meta`},`node=`+e.node+`  type=`+e.type+`  L`+e.tier),d.default.createElement(`div`,{className:`nmg-recall-pill-preview`},e.preview))),F.activeGraphId?d.default.createElement(`div`,{className:`nmg-recall-pill-meta`},`activeGraphId=`+F.activeGraphId):null,j.length>1?d.default.createElement(`div`,{className:`nmg-recall-pill-nav`},d.default.createElement(`button`,{type:`button`,className:`nmg-recall-pill-navbtn`,disabled:P<=0,onPointerDown:e=>e.stopPropagation(),onClick:e=>{e.stopPropagation(),T(e=>Math.max(0,e-1))}},`‹ 更早`),d.default.createElement(`span`,{className:`nmg-recall-pill-meta`},P+1+` / `+j.length),d.default.createElement(`button`,{type:`button`,className:`nmg-recall-pill-navbtn`,disabled:P>=j.length-1,onPointerDown:e=>e.stopPropagation(),onClick:e=>{e.stopPropagation(),T(e=>Math.min(j.length-1,e+1))}},`更新 ›`)):null):null,o?d.default.createElement(`div`,{className:`nmg-recall-pill-resize`,onPointerDown:e=>{e.stopPropagation(),k(e,`resize`)}}):null)}let y=[p(),e.on(`theme/change`,()=>i())];for(let t of _)y.push(e.slots.inject(`tool.call.toolview`,()=>e.slots.register({name:`tool.call.toolview`,key:t},e=>d.default.createElement(o,e))));return y.push(e.slots.inject(`shell.overlay`,()=>e.slots.register({name:`shell.overlay`,id:`nmg-recall-overlay`,order:50},e=>d.default.createElement(v,e)))),()=>{for(let e of y)typeof e==`function`&&e();n.clear()}}return n.apply=T,n.inject=w,t.exports}});