import {paidQueue,paidQueueDeploymentId} from '../paid-dispatch';
import {invocationDeadline} from '../deadline';
import {NativeDeliveryRetry} from '../consume';
import {runPaidQueueMessage} from '../paid-runtime';
import {publishDelegatedHostWork} from '../delegated-host-runtime';
/** Private queue callback only; never expose a public rewrite. */
export function POST(request:Request){const deadlineAt=invocationDeadline(300000);console.info('paid_queue_callback_received');
 if(!paidQueueDeploymentId)return Response.json({error:'Paid queue deployment identity unavailable'},{status:503});
 return paidQueue.handleCallback<unknown>(async payload=>{
 console.info('paid_queue_handler_started');
 await runPaidQueueMessage(payload,deadlineAt);
 // Retried old-generation callbacks still publish the original root outbox.
 // A completed payment must not lose its final continuation on transport loss.
 if(deadlineAt-Date.now()<20000)throw new NativeDeliveryRetry();
 {const published=await publishDelegatedHostWork(deadlineAt);if(published.unconfirmed)throw new NativeDeliveryRetry();}
 console.info('paid_queue_handler_finished');
},{visibilityTimeoutSeconds:300,retry:error=>({afterSeconds:error instanceof NativeDeliveryRetry?error.afterSeconds:30})})(request);}
