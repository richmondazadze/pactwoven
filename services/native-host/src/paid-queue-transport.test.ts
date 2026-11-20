import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const runtime=vi.hoisted(()=>({paid:vi.fn(),publish:vi.fn(),native:vi.fn()}));
vi.mock('./paid-runtime',()=>({runPaidQueueMessage:runtime.paid}));
vi.mock('./delegated-host-runtime',()=>({publishDelegatedHostWork:runtime.publish}));
vi.mock('./worker-runtime',()=>({runNativeQueueMessage:runtime.native}));

type Captured={url:string;method:string;headers:Headers;body:string|null};
const payload={schemaVersion:1,environment:'development',target:{operationId:'same-operation',generation:42}};
const paidTopic='pactwoven-paid-computation-v1',nativeTopic='pactwoven-native-advice-v1';
let requests:Captured[]=[];
function callback(topic=paidTopic,inline=false,version=2){
 if(version===1)return new Request('https://executor.example/api/consume-paid',{method:'POST',headers:{'content-type':'application/cloudevents+json'},body:JSON.stringify({type:'com.vercel.queue.v1beta',source:'test-queue',id:'event',data:{queueName:topic,consumerGroup:'consumer',messageId:'same-message'}})});
 return new Request('https://executor.example/api/consume-paid',{method:'POST',headers:{'ce-type':'com.vercel.queue.v2beta','ce-vqsqueuename':topic,'ce-vqsconsumergroup':'consumer','ce-vqsmessageid':'same-message','ce-vqsregion':'iad1',...(inline?{'ce-vqsreceipthandle':'same-receipt','ce-vqsdeliverycount':'1','content-type':'application/json'}:{})},...(inline?{body:JSON.stringify(payload)}:{})});
}
function received(){
 const boundary='queue-test-boundary';
 const part=['--'+boundary,'Content-Type: application/json','Vqs-Message-Id: same-message','Vqs-Receipt-Handle: same-receipt','Vqs-Delivery-Count: 1','Vqs-Timestamp: '+new Date().toISOString(),'',''+JSON.stringify(payload),'--'+boundary+'--',''].join('\r\n');
 return new Response(part,{status:200,headers:{'content-type':'multipart/mixed; boundary='+boundary}});
}
beforeEach(()=>{
 vi.resetModules();requests=[];runtime.paid.mockReset().mockResolvedValue('settled');runtime.publish.mockReset().mockResolvedValue({accepted:1,unconfirmed:0});runtime.native.mockReset().mockResolvedValue('settled');
 vi.stubEnv('VERCEL_ENV','production');vi.stubEnv('VERCEL_DEPLOYMENT_ID','dpl_current_test');
 const token=[{alg:'none'},{exp:Math.floor(Date.now()/1000)+3600},'test-only'].map(x=>Buffer.from(typeof x==='string'?x:JSON.stringify(x)).toString('base64url')).join('.');vi.stubEnv('VERCEL_OIDC_TOKEN',token);
 vi.spyOn(console,'info').mockImplementation(()=>{});vi.spyOn(console,'error').mockImplementation(()=>{});
 vi.stubGlobal('fetch',vi.fn(async(url:unknown,init:RequestInit)=>{
  requests.push({url:String(url),method:init.method??'GET',headers:new Headers(init.headers),body:typeof init.body==='string'?init.body:null});
  return init.method==='POST'&&String(url).includes('/id/')?received():init.method==='POST'?Response.json({messageId:'same-message'}):new Response('',{status:200});
 }));
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();vi.resetModules();});
function assertPaidPinned(){expect(requests.every(r=>r.headers.get('Vqs-Deployment-Id')==='dpl_current_test')).toBe(true);expect(requests.every(r=>r.url.includes(paidTopic))).toBe(true);}
describe('paid receiver consistency using installed real Vercel Queue SDK',()=>{
 it.each([1,2])('receives V%s non-inline delivery and ACKs through the same pinned to the current deployment client',async version=>{
  const {POST}=await import('./handlers/consume-paid');const response=await POST(callback(paidTopic,false,version));
  expect(response.status).toBe(200);expect(await response.json()).toEqual({status:'success'});
  expect(requests.map(r=>r.method)).toEqual(['POST','DELETE']);assertPaidPinned();
  expect(requests[0]!.url).toContain('/consumer/consumer/id/same-message');expect(requests[0]!.headers.get('Vqs-Visibility-Timeout-Seconds')).toBe('300');expect(requests[1]!.url).toContain('/lease/same-receipt');
  expect(runtime.paid).toHaveBeenCalledExactlyOnceWith(payload,expect.any(Number));expect(runtime.publish).toHaveBeenCalledOnce();
  expect(console.info).toHaveBeenNthCalledWith(1,'paid_queue_callback_received');expect(console.info).toHaveBeenNthCalledWith(2,'paid_queue_handler_started');expect(console.info).toHaveBeenNthCalledWith(3,'paid_queue_handler_finished');
 });
 it('handles inline delivery without fetching it and ACKs pinned to the current deployment',async()=>{
  const {POST}=await import('./handlers/consume-paid');expect((await POST(callback(paidTopic,true))).status).toBe(200);
  expect(requests.map(r=>r.method)).toEqual(['DELETE']);assertPaidPinned();expect(runtime.paid).toHaveBeenCalledExactlyOnceWith(payload,expect.any(Number));
 });
 it.each(['paid','continuation'])('reschedules %s failure pinned to the current deployment and never acknowledges it',async failure=>{
  const {NativeDeliveryRetry}=await import('./consume');if(failure==='paid')runtime.paid.mockRejectedValueOnce(new NativeDeliveryRetry(17));else runtime.publish.mockResolvedValueOnce({accepted:0,unconfirmed:1});
  const {POST}=await import('./handlers/consume-paid');expect((await POST(callback())).status).toBe(200);
  expect(requests.map(r=>r.method)).toEqual(['POST','PATCH']);assertPaidPinned();expect(JSON.parse(requests[1]!.body!)).toEqual({visibilityTimeoutSeconds:failure==='paid'?17:30});
  if(failure==='paid')expect(runtime.publish).not.toHaveBeenCalled();expect(console.info).not.toHaveBeenCalledWith('paid_queue_handler_finished');
 });
 it('uses the bounded generic error retry without exposing its details in labels',async()=>{
  runtime.paid.mockRejectedValueOnce(new Error('synthetic private diagnostic'));const {POST}=await import('./handlers/consume-paid');await POST(callback(paidTopic,true));
  expect(requests.map(r=>r.method)).toEqual(['PATCH']);assertPaidPinned();expect(JSON.parse(requests[0]!.body!)).toEqual({visibilityTimeoutSeconds:30});expect(console.info).toHaveBeenCalledTimes(2);
 });
 it('preserves native advice receive and ACK deployment affinity',async()=>{
  const {POST}=await import('./handlers/consume');expect((await POST(callback(nativeTopic))).status).toBe(200);
  expect(requests.map(r=>r.method)).toEqual(['POST','DELETE']);expect(requests.every(r=>r.headers.get('Vqs-Deployment-Id')==='dpl_current_test')).toBe(true);expect(requests.every(r=>r.url.includes(nativeTopic))).toBe(true);expect(runtime.native).toHaveBeenCalledOnce();expect(runtime.paid).not.toHaveBeenCalled();
 });
 it('keeps sender and callback on the same captured deployment if process environment changes later',async()=>{
  const {sendPaidQueueMessage}=await import('./paid-dispatch');const {POST}=await import('./handlers/consume-paid');vi.stubEnv('VERCEL_DEPLOYMENT_ID','dpl_later_test');
  await sendPaidQueueMessage({...payload,schemaVersion:1,environment:'development'},{idempotencyKey:'same-key',retentionSeconds:86400,delaySeconds:0});
  expect((await POST(callback())).status).toBe(200);expect(requests.map(r=>r.method)).toEqual(['POST','POST','DELETE']);assertPaidPinned();expect(runtime.paid).toHaveBeenCalledOnce();
 });
 it.each([false,true])('fails closed on sends and inline=%s callbacks when deployment identity is missing',async inline=>{
  vi.stubEnv('VERCEL_DEPLOYMENT_ID',undefined);vi.stubEnv('NODE_ENV','production');
  const {sendPaidQueueMessage}=await import('./paid-dispatch');
  await expect(sendPaidQueueMessage({...payload,schemaVersion:1,environment:'development'},{idempotencyKey:'same-key',retentionSeconds:86400,delaySeconds:0})).rejects.toThrow(/deployment/i);
  const {POST}=await import('./handlers/consume-paid');const response=await POST(callback(paidTopic,inline));expect(response.status).toBe(503);expect(requests).toHaveLength(0);expect(runtime.paid).not.toHaveBeenCalled();expect(runtime.publish).not.toHaveBeenCalled();
 });
 it('does not invoke payment runtime when a malformed callback is rejected',async()=>{
  const {POST}=await import('./handlers/consume-paid');const response=await POST(new Request('https://executor.example/api/consume-paid',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}));expect(response.status).toBe(400);expect(requests).toHaveLength(0);expect(runtime.paid).not.toHaveBeenCalled();expect(runtime.publish).not.toHaveBeenCalled();
 });
});
