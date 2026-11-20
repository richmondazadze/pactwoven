import { DomainError } from '@pactwoven/domain';

const bodyDeadlineMs=5000;
const invalid=()=>new DomainError('CUSTODY_INPUT_INVALID',422,'A strict JSON object is required.');
/** Walk JSON syntax without losing duplicate keys (including escaped aliases) to JSON.parse. */
function strictObject(text:string):object {
 let at=0,tokens=0;
 const whitespace=()=>{while(at<text.length&&/[\u0020\t\r\n]/.test(text[at]!))at++;};
 function string():string {const start=at;if(text[at++]!=='"')throw invalid();let escaped=false;
  while(at<text.length){const c=text[at++]!;if(escaped){escaped=false;continue;}if(c==='\\'){escaped=true;continue;}if(c==='"'){try{return JSON.parse(text.slice(start,at)) as string;}catch{throw invalid();}}}throw invalid();}
 function value(depth:number):void {
  if(depth>16||++tokens>256)throw invalid();whitespace();const c=text[at];
  if(c==='{'){at++;whitespace();const keys=new Set<string>();if(text[at]==='}'){at++;return;}
   for(;;){whitespace();const key=string();if(keys.has(key)||keys.size>=64)throw invalid();keys.add(key);whitespace();if(text[at++]!==':')throw invalid();value(depth+1);whitespace();if(text[at]==='}'){at++;return;}if(text[at++]!==',')throw invalid();}
  }
  if(c==='['){at++;whitespace();let count=0;if(text[at]===']'){at++;return;}for(;;){if(++count>64)throw invalid();value(depth+1);whitespace();if(text[at]===']'){at++;return;}if(text[at++]!==',')throw invalid();}}
  if(c==='"'){string();return;}
  for(const literal of ['true','false','null'])if(text.startsWith(literal,at)){at+=literal.length;return;}
  const number=/-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(at));
  if(!number||number.index!==0||!Number.isFinite(Number(number[0])))throw invalid();at+=number[0].length;
 }
 value(0);whitespace();if(at!==text.length)throw invalid();let parsed:unknown;try{parsed=JSON.parse(text);}catch{throw invalid();}
 if(typeof parsed!=='object'||parsed===null||Array.isArray(parsed))throw invalid();return parsed;
}
export async function readBoundedStrictJson(request:Request,maximumBytes:number):Promise<{ value: object; bytes: number }> {
 if(![2048,4096,8192,65536].includes(maximumBytes))throw new DomainError('SETUP_REQUIRED',503,'Strict body limits are not configured.');
 if(!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(request.headers.get('content-type')??'')||
  !['','identity'].includes((request.headers.get('content-encoding')??'').toLowerCase()))throw new DomainError('UNSUPPORTED_MEDIA_TYPE',415,'Send uncompressed UTF-8 JSON.');
 const length=request.headers.get('content-length');if(length!==null&&(!/^[0-9]+$/.test(length)||Number(length)>maximumBytes))throw new DomainError('BODY_TOO_LARGE',413,'The setup request exceeds its size limit.');
 const reader=request.body?.getReader();if(!reader)throw invalid();let bytes=0,text='';const decoder=new TextDecoder('utf-8',{fatal:true});let timer:ReturnType<typeof setTimeout>|undefined;
 const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new DomainError('REQUEST_TIMEOUT',408,'The setup body took too long.')),bodyDeadlineMs);});
 try{for(;;){const chunk=await Promise.race([reader.read(),deadline]);if(chunk.done)break;if(!(chunk.value instanceof Uint8Array))throw invalid();bytes+=chunk.value.byteLength;if(bytes>maximumBytes)throw new DomainError('BODY_TOO_LARGE',413,'The setup request exceeds its size limit.');text+=decoder.decode(chunk.value,{stream:true});}
  text+=decoder.decode();const parsed=strictObject(text);return { value: parsed, bytes };
 }catch(error){void reader.cancel().catch(()=>{});if(error instanceof DomainError)throw error;throw invalid();}
 finally{clearTimeout(timer);reader.releaseLock();}
}
