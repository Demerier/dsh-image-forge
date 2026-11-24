/** Capture the final canvas and node editor at the chosen review viewport. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE=fileURLToPath(new URL('.',import.meta.url)); const ROOT=resolve(HERE,'..','..','..'); const OUT=resolve(ROOT,'verify','qa-20261124'); mkdirSync(OUT,{recursive:true})
const PAGE_URL=(process.env.PREVIEW_URL??'http://127.0.0.1:8390/').replace(/\/?$/,'/'); const PORT=Number(process.env.PREVIEW_CDP_PORT??9342)
const VIEWPORT={width:1500,height:1000}
const BROWSERS=[process.env.PREVIEW_CHROME,'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter((p)=>typeof p==='string'&&existsSync(p))
if(!BROWSERS.length) throw new Error('no browser')
const profile=mkdtempSync(join(tmpdir(),'forge-design-')); const browser=spawn(BROWSERS[0],['--headless=new',`--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,'--hide-scrollbars','--no-first-run','--no-default-browser-check','--disable-extensions','--force-device-scale-factor=1','about:blank'],{stdio:'ignore'})
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
async function connect(){for(let i=0;i<80;i++){try{const rows=await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();const page=rows.find(r=>r.type==='page'&&r.webSocketDebuggerUrl);if(page)return page.webSocketDebuggerUrl}catch{}await sleep(350)}throw new Error('no page')}
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
 await until('window.__pv && window.__pv.mounted === true',40000,'workbench')
 await ev('window.__pv.activateCanvas()');await until("document.querySelectorAll('[data-node-kind]').length >= 6",30000,'canvas nodes');await until("[...document.querySelectorAll('img.dsh-forge-flow-thumb')].every(img=>img.complete&&img.naturalWidth>0)",20000,'node thumbnails');await sleep(700)
 report.canvas=await ev(`(()=>({nodes:document.querySelectorAll('[data-node-kind]').length,captions:[...document.querySelectorAll('.dsh-forge-node-caption')].map(n=>n.textContent),tools:[...document.querySelectorAll('.dsh-forge-canvas-dock button')].map(n=>n.textContent),canvasHeight:document.querySelector('.react-flow')?.getBoundingClientRect().height}))()`)
 report.canvasShot=await shot('final-canvas-1500-light-v2')
 await ev(`(()=>{const node=document.querySelector('[data-node-id="node-tall"]');node?.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:600,clientY:300}));node?.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:600,clientY:300}));return node!==null})()`)
 await until("document.querySelector('.dsh-forge-node-editor, .dsh-forge-inspector') !== null",12000,'node editor');await sleep(500)
 report.editor=await ev(`(()=>({exists:document.querySelector('.dsh-forge-node-editor, .dsh-forge-inspector')!==null,prompt:document.querySelector('.dsh-forge-inspector textarea')?.value??null,selected:document.querySelectorAll('.dsh-forge-flow-node.is-selected').length,inspectorRect:document.querySelector('.dsh-forge-node-editor, .dsh-forge-inspector')?.getBoundingClientRect().toJSON()}))()`)
 report.editorShot=await shot('final-editor-1500-light-v2')
 report.ok=true
}catch(error){report.ok=false;report.failure=error instanceof Error?error.message:String(error);console.error('FAILED',report.failure)}finally{report.consoleErrors=errors;report.failedRequests=failed;writeFileSync(join(OUT,'design-canvas-report.json'),JSON.stringify(report,null,2));console.log('report',join(OUT,'design-canvas-report.json'));try{ws.close()}catch{};browser.kill();if(report.ok!==true)process.exitCode=1}
