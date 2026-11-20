import { nativeQueue } from './queue';
import type { DelegatedQueueSend } from './delegated-dispatch';

export const DELEGATED_WORK_TOPIC = 'pactwoven-delegated-advice-v1';
export const sendDelegatedQueueMessage: DelegatedQueueSend = (message, options) => nativeQueue.send(DELEGATED_WORK_TOPIC, message, options);
