/** Browser QA for the Canvas 2.1 interaction surfaces. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE=fileURLToPath(new URL('.',import.meta.url)); const ROOT=resolve(HERE,'..','..','..'); const OUT=resolve(ROOT,'verify','qa-20261124'); mkdirSync(OUT,{recursive:true})
const PAGE_URL=(process.env.PREVIEW_URL??'http://127.0.0.1:8390/').replace(/\/?$/,'/'); const PORT=Number(process.env.PREVIEW_CDP_PORT??9344); const VIEWPORT={width:1500,height:1000}
const BROWSERS=[process.env.PREVIEW_CHROME,'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter((p)=>typeof p==='string'&&existsSync(p)); if(!BROWSERS.length)throw new Error('no browser')
const profile=mkdtempSync(join(tmpdir(),'forge-canvas21-')); const browser=spawn(BROWSERS[0],['--headless=new',`--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,'--hide-scrollbars','--no-first-run','--no-default-browser-check','--disable-extensions','--force-device-scale-factor=1','about:blank'],{stdio:'ignore'})
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms)); async function connect(){for(let i=0;i<80;i++){try{const rows=await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();const page=rows.find(r=>r.type==='page'&&r.webSocketDebuggerUrl);if(page)return page.webSocketDebuggerUrl}catch{}await sleep(350)}throw new Error('no page')}
const ws=new WebSocket(await connect()); await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})})
let id=1;const pending=new Map();const errors=[];const failed=[]
ws.addEventListener('message',e=>{const m=JSON.parse(String(e.data));if(m.id!==undefined){const w=pending.get(m.id);if(!w)return;pending.delete(m.id);m.error?w.reject(new Error(m.error.message)):w.resolve(m.result);return}if(m.method==='Runtime.consoleAPICalled'&&['error','assert','warning'].includes(m.params.type))errors.push(`${m.params.type}: ${m.params.args.map(a=>typeof a.value==='string'?a.value:a.description??a.type).join(' ')}`);if(m.method==='Runtime.exceptionThrown')errors.push(`exception: ${m.params.exceptionDetails.exception?.description??m.params.exceptionDetails.text}`);if(m.method==='Network.responseReceived'&&m.params.response.status>=400)failed.push(`HTTP ${m.params.response.status} ${m.params.response.url}`)})
function send(method,params={}){const n=id++;return new Promise((r,j)=>{pending.set(n,{resolve:r,reject:j});ws.send(JSON.stringify({id:n,method,params}))})}
async function ev(expression){const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result?.value}
async function until(expression,ms,label){const started=Date.now();while(Date.now()-started<ms){if(await ev(expression))return;await sleep(180)}throw new Error(`timeout: ${label}`)}
async function shot(name){const r=await send('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:VIEWPORT.width,height:VIEWPORT.height,scale:1}});const p=join(OUT,`${name}.png`);writeFileSync(p,Buffer.from(r.data,'base64'));return p}
const report={url:PAGE_URL,viewport:VIEWPORT,deviceScaleFactor:1,consoleErrors:errors,failedRequests:failed}
try{
 await send('Page.enable');await send('Runtime.enable');await send('Network.enable');await send('Emulation.setDeviceMetricsOverride',{...VIEWPORT,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:PAGE_URL})
 await until('window.__pv && window.__pv.mounted === true',40000,'workbench');await ev('window.__pv.activateCanvas()');await until("document.querySelectorAll('[data-node-id]').length >= 8",30000,'canvas nodes');await sleep(700)
 // Stable two-mode header and grouped tool dock.
 report.header=await ev(`(()=>({modes:[...document.querySelectorAll('.dsh-forge-workspace-mode-bar .dsh-forge-view-item')].map(n=>n.textContent),modeBarTop:document.querySelector('.dsh-forge-workspace-mode-bar')?.getBoundingClientRect().top,tools:[...document.querySelectorAll('.dsh-forge-canvas-tool')].map(n=>n.textContent.trim()),contextWidth:document.querySelector('.dsh-forge-context-panel')?.getBoundingClientRect().width??0}))()`)
 report.canvasShot=await shot('canvas21-canvas')
const beforeNodes=await ev("document.querySelectorAll('[data-node-id]').length")
await ev("document.querySelector('button[aria-label=\"新建生成节点\"]')?.click()")
await until(`document.querySelectorAll('[data-node-id]').length === ${beforeNodes + 1}`,10000,'new node')
await until("document.querySelector('.dsh-forge-flow-node.is-created-focus') !== null",2000,'creation highlight').catch(()=>{})
report.createNode=await ev(`(()=>({count:document.querySelectorAll('[data-node-id]').length,highlight:document.querySelector('.dsh-forge-flow-node.is-created-focus')!==null,selected:document.querySelectorAll('.dsh-forge-flow-node.is-selected').length}))()`)
 // Context menu closes on any outside left pointerdown.
 await ev(`(()=>{const pane=document.querySelector('.react-flow__pane');pane?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:620,clientY:420}));return pane!==null})()`)
 await until("document.querySelector('.dsh-forge-context') !== null",5000,'context menu')
 const menuOpened=await ev("document.querySelector('.dsh-forge-context') !== null")
 await ev(`(()=>{const target=document.querySelector('.dsh-forge-canvas-top-actions')??document.body;target.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:50,clientY:50}));return true})()`)
 await until("document.querySelector('.dsh-forge-context') === null",5000,'context menu dismissal')
 report.contextMenu={opened:menuOpened,dismissed:true}
 // Image node opens the in-flow property page, not an anchored floating drawer.
 await ev(`(()=>{const node=document.querySelector('[data-node-id="node-wide"]');node?.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:700,clientY:300}));node?.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:700,clientY:300}));return node!==null})()`)
 await until("document.querySelector('.dsh-forge-context-panel') !== null",10000,'context panel');await sleep(450)
 report.contextPanel=await ev(`(()=>{const p=document.querySelector('.dsh-forge-context-panel');const s=p?getComputedStyle(p):null;return {kind:p?.dataset.contextKind,width:p?.getBoundingClientRect().width,parent:p?.parentElement?.className,display:s?.display,flex:s?.flex,position:s?.position,right:s?.right,height:p?.getBoundingClientRect().height,bodyScroll:document.querySelector('.dsh-forge-context-panel .dsh-forge-inspector-body')?.scrollHeight,bodyClient:document.querySelector('.dsh-forge-context-panel .dsh-forge-inspector-body')?.clientHeight}})()`)
 report.contextShot=await shot('canvas21-context-panel')
 // Gallery keeps the traditional form + result layout.
 await ev(`(()=>{const b=[...document.querySelectorAll('.dsh-forge-view-item')].find(n=>n.textContent.trim()==='画廊');b?.click();return b!==undefined})()`)
 await until("document.querySelector('.dsh-forge-studio-body.is-gallery') !== null",10000,'gallery');await sleep(500)
 report.gallery=await ev(`(()=>({form:document.querySelector('.dsh-forge-studio-form')!==null,scope:[...document.querySelectorAll('.dsh-forge-gallery-scope-item')].map(n=>n.textContent),modeBarTop:document.querySelector('.dsh-forge-workspace-mode-bar')?.getBoundingClientRect().top,headTop:document.querySelector('.dsh-forge-results-head.is-gallery')?.getBoundingClientRect().top}))()`)
report.modeBarStable=report.gallery.modeBarTop===report.header.modeBarTop
if(!report.modeBarStable)throw new Error('workspace mode bar moved between canvas and gallery')
 report.galleryShot=await shot('canvas21-gallery')
 // Back to canvas and open the layout detail page.
 await ev(`(()=>{const b=[...document.querySelectorAll('.dsh-forge-view-item')].find(n=>n.textContent.trim()==='画布');b?.click();return b!==undefined})()`);await until("document.querySelector('[data-node-id=\"node-layout\"]') !== null",15000,'layout node')
 await ev(`(()=>{const node=document.querySelector('[data-node-id="node-layout"]');node?.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:900,clientY:720}));node?.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:900,clientY:720}));return node!==null})()`);await until("document.querySelector('.dsh-forge-context-panel') !== null",10000,'layout summary')
 await ev(`(()=>{const b=[...document.querySelectorAll('.dsh-forge-context-panel button')].find(n=>n.textContent.trim()==='打开详情');b?.click();return b!==undefined})()`)
 await until("document.querySelector('.dsh-forge-detail.is-layout .dsh-forge-layout-workspace') !== null",20000,'layout detail');await sleep(900)
 report.layoutDetail=await ev(`(()=>({canvas:document.querySelector('.dsh-forge-layout-canvas-pane')!==null,rail:document.querySelector('.dsh-forge-layout-rail')!==null,boxRows:document.querySelectorAll('.dsh-forge-layout-box-row').length,pageOverflow:getComputedStyle(document.querySelector('.dsh-forge-detail-body.is-layout')).overflow,canvasOnly:document.querySelector('.dsh-forge-layout-editor .dsh-forge-layout-item-row')===null}))()`)
 report.layoutShot=await shot('canvas21-layout-detail')
 await ev(`(()=>{const b=document.querySelector('.dsh-forge-layout-box-edit');b?.click();return b!==undefined})()`);await until("document.querySelector('.dsh-forge-box-float') !== null",10000,'box property float');await sleep(350)
 report.boxFloat=await ev(`(()=>({fields:[...document.querySelectorAll('.dsh-forge-box-float .dsh-forge-label')].map(n=>n.textContent),hasCanvas:document.querySelector('.dsh-forge-box-float .dsh-forge-layout-canvas')!==null,width:document.querySelector('.dsh-forge-box-float')?.getBoundingClientRect().width}))()`)
 report.boxFloatShot=await shot('canvas21-box-float')
 report.ok=true
}catch(error){report.ok=false;report.failure=error instanceof Error?error.message:String(error);console.error('FAILED',report.failure)}finally{report.consoleErrors=errors;report.failedRequests=failed;writeFileSync(join(OUT,'canvas21-report.json'),JSON.stringify(report,null,2));console.log('report',join(OUT,'canvas21-report.json'));try{ws.close()}catch{};browser.kill();if(report.ok!==true)process.exitCode=1}
