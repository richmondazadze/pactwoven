import type { Pool } from 'pg';
import type { Environment } from '@pactwoven/contracts';
import { assertNativeDelegationPool, createNativeDelegationPool } from './native-delegation-pool';
export type NativeMemoryPoolPurpose = 'api' | 'coordinator' | 'worker';
/** Memory uses the exact reviewed v2 union. No v1 service role is widened. */
export function assertNativeMemoryPool(pool:Pool,environment:Environment,purpose:NativeMemoryPoolPurpose):Promise<void> {
  return assertNativeDelegationPool(pool,environment,purpose,'delegation-memory');
}
export function createNativeMemoryPool(connectionString:string,environment:Environment,purpose:NativeMemoryPoolPurpose):Promise<Pool> {
  return createNativeDelegationPool(connectionString,environment,purpose,'delegation-memory');
}
