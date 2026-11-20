import {nativeQueue} from './queue';
import type {PaidToolQueueSend} from '../../paid-tools/src/host-queue';
export const PAID_WORK_TOPIC='pactwoven-paid-computation-v1';
export const sendPaidQueueMessage:PaidToolQueueSend=(message,options)=>nativeQueue.send(PAID_WORK_TOPIC,message,options);
