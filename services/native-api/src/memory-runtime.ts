import { nativeDelegatedResources } from './delegated-runtime.js';

export async function nativeMemoryApp() { return (await nativeDelegatedResources()).app; }
