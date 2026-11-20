import { QueueClient } from '@vercel/queue';

export const NATIVE_WORK_TOPIC = 'pactwoven-native-advice-v1';
// The queue stores IDs only. Credentials come from Vercel's workload identity,
// never a user-supplied endpoint, bearer token or model output.
export const nativeQueue = new QueueClient({ region: 'iad1', telemetry: { isEnabled: false } });
