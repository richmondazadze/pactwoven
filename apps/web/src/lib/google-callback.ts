import { GOOGLE_CALLBACK_ACK_KIND, GOOGLE_CALLBACK_CHANNEL_PREFIX, GOOGLE_CALLBACK_KIND, GOOGLE_CALLBACK_PATH, GOOGLE_SETTINGS_PATH } from './google-access';

/** Standalone document: no React layout, authentication client, analytics, remote
 * assets, query reflection or logging. Hosting receives the query before this code. */
export function googleCallbackDocument(nonce: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(nonce)) throw new Error('Invalid callback nonce');
  const script = `(()=>{'use strict';
let query=location.search;
try{history.replaceState(null,'',${JSON.stringify(GOOGLE_CALLBACK_PATH)});}catch{query='';return;}
let message=null;
try{const p=new URLSearchParams(query);query='';const state=p.get('state');
if(p.getAll('state').length===1&&/^[A-Za-z0-9_-]{43}$/.test(state||'')){
if(p.getAll('code').length===1&&!p.has('error')&&(p.get('code')||'').length<=8192&&/^[^\\u0000-\\u001f\\u007f]+$/.test(p.get('code')||'')){message={kind:${JSON.stringify(GOOGLE_CALLBACK_KIND)},result:'code',state,code:p.get('code')};}
else if(p.getAll('error').length===1&&!p.has('code')){message={kind:${JSON.stringify(GOOGLE_CALLBACK_KIND)},result:'cancelled',state};}}
p.delete('code');p.delete('state');}catch{query='';}
const state=message?.state,result=message?.result;
let channel=null,timer=null,finished=false;
let statusText=message?'Returning the response to the original Pactwoven window…':'Google did not return a valid connection response. Close this window and start again from Google Calendar settings.';
const render=()=>{const status=document.getElementById('result');if(status)status.textContent=statusText;};
const cleanup=()=>{if(timer!==null)clearTimeout(timer);timer=null;channel?.close();channel=null;window.removeEventListener('message',receive);window.removeEventListener('pagehide',cleanup);if(message&&'code'in message)message.code='';message=null;};
const finish=accepted=>{if(finished)return;finished=true;statusText=accepted?'The original Pactwoven window received the response. Return there to check whether the connection completed.':'This connection could not return to the original window. Check the original attempt in Google Calendar settings before starting again.';cleanup();render();};
function receive(event){const data=event.data;if(event.origin!==location.origin||event.source!==window.opener||!window.opener)return;accept(data);}
function accept(data){if(data&&typeof data==='object'&&Object.keys(data).sort().join(',')==='kind,result,state'&&data.kind===${JSON.stringify(GOOGLE_CALLBACK_ACK_KIND)}&&data.state===state&&data.result===result)finish(true);}
document.addEventListener('DOMContentLoaded',()=>{render();document.getElementById('close')?.addEventListener('click',()=>{cleanup();window.close();});});
if(!message)return;
window.addEventListener('message',receive);window.addEventListener('pagehide',cleanup);
let sent=false;
try{channel=new BroadcastChannel(${JSON.stringify(GOOGLE_CALLBACK_CHANNEL_PREFIX)}+state);channel.onmessage=event=>{if(event.origin===location.origin)accept(event.data);};}catch{}
timer=setTimeout(()=>finish(false),5000);
try{if(window.opener&&!window.opener.closed){window.opener.postMessage(message,location.origin);sent=true;}}catch{}
try{if(channel){channel.postMessage(message);sent=true;}}catch{}
if(message&&'code'in message)message.code='';message=null;
if(!sent)finish(false);
})();`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><script nonce="${nonce}">${script}</script><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Return to Pactwoven</title><style nonce="${nonce}">body{font:16px/1.6 system-ui,sans-serif;color:#111318;background:#f5f7fa;margin:0;padding:48px 24px}main{max-width:520px;margin:12vh auto;padding:32px;background:white;border:1px solid #d9e0e9;border-radius:16px}h1{font-size:28px;line-height:1.2}p{color:#485568}a,button{display:inline-block;font:inherit;font-weight:600;border:1px solid #c3ccd9;border-radius:8px;padding:10px 16px;background:white;color:#155eef;margin:8px 8px 0 0;cursor:pointer}a:focus-visible,button:focus-visible{outline:3px solid #155eef;outline-offset:3px}</style></head><body><main><h1>Return to Pactwoven</h1><p id="result" role="status">For your privacy, close this window and reopen Google Calendar settings if the connection does not finish.</p><button id="close" type="button">Close window</button><a href="${GOOGLE_SETTINGS_PATH}" rel="noreferrer">Open settings</a><noscript><p>JavaScript is needed to finish this connection. Close this window, enable JavaScript, then start again from settings.</p></noscript></main></body></html>`;
}
export function googleCallbackResponse() {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  return new Response(googleCallbackDocument(nonce), { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store, max-age=0',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  } });
}
