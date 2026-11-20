import { googleCallbackResponse } from '@/lib/google-callback';

export const dynamic = 'force-dynamic';
export function GET() { return googleCallbackResponse(); }
