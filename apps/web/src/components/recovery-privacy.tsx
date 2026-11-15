'use client';
import { useAuth } from '@clerk/nextjs';
import { useEffect, type ReactNode } from 'react';
import { clearAccessRecovery } from '@/lib/access-recovery';
import { browserRecoveryStorage, clearBootstrapRecovery } from '@/lib/bootstrap-recovery';
export function RecoveryPrivacyBoundary({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, userId, orgId } = useAuth();
  useEffect(() => { if (!isLoaded) return; const keep = isSignedIn && userId ? { userId, organizationId: orgId ?? null } : undefined; clearBootstrapRecovery(browserRecoveryStorage(), keep); clearAccessRecovery(browserRecoveryStorage()); }, [isLoaded, isSignedIn, userId, orgId]);
  return children;
}
