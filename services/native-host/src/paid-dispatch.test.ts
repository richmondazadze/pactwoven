import {afterEach,describe,expect,it,vi} from 'vitest';

afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.resetModules();});

describe('paid dispatch deployment routing with actual queue SDK',()=>{
 it('pins paid and native sends to the current deployment and preserves body/idempotency',async()=>{
  vi.stubEnv('VERCEL_ENV','production');
  vi.stubEnv('VERCEL_DEPLOYMENT_ID','dpl_current_test');
  const syntheticToken=[{alg:'none'},{exp:Math.floor(Date.now()/1000)+3600},'test-only'].map(x=>Buffer.from(typeof x==='string'?x:JSON.stringify(x)).toString('base64url')).join('.');
  vi.stubEnv('VERCEL_OIDC_TOKEN',syntheticToken);
  const requests:Array<{url:string;headers:Headers;body:unknown}>=[];
  vi.stubGlobal('fetch',vi.fn(async(url:unknown,init:RequestInit)=>{
   requests.push({url:String(url),headers:new Headers(init.headers),body:JSON.parse(Buffer.from(init.body as Uint8Array).toString())});
   return new Response(JSON.stringify({messageId:'test-message'}),{status:200,headers:{'content-type':'application/json'}});
  }));
  const {sendPaidQueueMessage,PAID_WORK_TOPIC}=await import('./paid-dispatch');
  const {nativeQueue,NATIVE_WORK_TOPIC}=await import('./queue');
  const message={schemaVersion:1 as const,environment:'development' as const,target:{operationId:'original-operation',generation:42}};
  await sendPaidQueueMessage(message,{idempotencyKey:'same-durable-generation',delaySeconds:2,retentionSeconds:86400});
  await nativeQueue.send(NATIVE_WORK_TOPIC,{originalAdvice:true},{idempotencyKey:'advice-key'});
  expect(requests).toHaveLength(2);
  expect(requests[0]!.url).toContain(PAID_WORK_TOPIC);
  expect(requests[0]!.headers.get('Vqs-Deployment-Id')).toBe('dpl_current_test');
  expect(requests[0]!.body).toEqual(message);
  expect([...requests[0]!.headers.values()]).toContain('same-durable-generation');
  expect(requests[1]!.headers.get('Vqs-Deployment-Id')).toBe('dpl_current_test');
  expect(requests[1]!.url).toContain(NATIVE_WORK_TOPIC);
 });
});
