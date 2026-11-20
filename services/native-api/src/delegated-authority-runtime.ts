import { nativeDelegatedResources } from './delegated-runtime.js';
import type { NativeDelegatedAuthorityResources } from './delegated-authority.js';

export async function nativeDelegatedAuthorityResources(): Promise<NativeDelegatedAuthorityResources> {
  return (await nativeDelegatedResources()).authority;
}
