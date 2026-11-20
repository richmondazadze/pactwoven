import {QueueClient} from '@vercel/queue';
import type {PaidToolQueueSend} from '../../paid-tools/src/host-queue';
export const PAID_WORK_TOPIC='pactwoven-paid-computation-v1';
// Push delivery and lease operations must share the current deployment.
// After a rollout, durable SQL dispatch generations republish recoverable work
// from the new deployment; omitting affinity selects deploymentless polling.
export const paidQueueDeploymentId=process.env.VERCEL_DEPLOYMENT_ID;
export const paidQueue=new QueueClient({region:'iad1',...(paidQueueDeploymentId?{deploymentId:paidQueueDeploymentId}:{}),telemetry:{isEnabled:false}});
export const sendPaidQueueMessage:PaidToolQueueSend=(message,options)=>paidQueue.send(PAID_WORK_TOPIC,message,options);
