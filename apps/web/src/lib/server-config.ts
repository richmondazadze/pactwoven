import 'server-only';
import { isPublishableKey } from './config';
export function authConfigured() {
  return isPublishableKey(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) && Boolean(process.env.CLERK_SECRET_KEY);
}
