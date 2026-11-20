import { attachDatabasePool } from '@vercel/functions';
import { createRuntimePool } from '@pactwoven/db';
import { createNativeGooglePool } from '../../../packages/db/src/native-google-pool';
import { readNativeGoogleConfig } from './google-config';
import { composeNativeGoogleApp } from './google-composition';
import { createNativeGoogleAppLoader } from './google-bootstrap';

// Imports create no connections and perform no OAuth/provider operation.
export const nativeGoogleApp = createNativeGoogleAppLoader({
  readConfig: () => readNativeGoogleConfig(process.env), openFoundation: createRuntimePool,
  openGoogle: createNativeGooglePool, compose: composeNativeGoogleApp, attach: attachDatabasePool,
});
