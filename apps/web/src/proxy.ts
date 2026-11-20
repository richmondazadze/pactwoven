import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse, type NextRequest, type NextFetchEvent } from 'next/server';
import { authConfigured } from './lib/server-config';
import { workspaceReturnPath } from './lib/workspace-return';
const withClerk = clerkMiddleware(async (auth, request) => {
  if (request.nextUrl.pathname === '/app' || request.nextUrl.pathname.startsWith('/app/')) {
    const session = await auth();
    if (!session.userId) return session.redirectToSignIn({ returnBackUrl: workspaceReturnPath(`${request.nextUrl.pathname}${request.nextUrl.search}`) });
  }
}, { signInUrl: '/sign-in', signUpUrl: '/sign-up' });
export default function proxy(request: NextRequest, event: NextFetchEvent) {
  // The dedicated callback scrubs OAuth query values before loading app code.
  // Sending it through a sign-in redirect would copy those values into a URL.
  if (request.nextUrl.pathname === '/app/settings/connections/google/callback') {
    const response = NextResponse.next();
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  }
  if (!authConfigured()) return NextResponse.next();
  return withClerk(request, event);
}
export const config = { matcher: ['/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)'] };
