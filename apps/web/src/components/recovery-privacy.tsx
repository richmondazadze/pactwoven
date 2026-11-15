'use client';
import { useAuth } from '@clerk/nextjs';
import { useEffect, type ReactNode } from 'react';
import { browserRecoveryStorage, clearBootstrapRecovery } from '@/lib/bootstrap-recovery';
export function RecoveryPrivacyBoundary({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, userId, orgId } = useAuth();
  useEffect(() => { if (!isLoaded) return; clearBootstrapRecovery(browserRecoveryStorage(), isSignedIn && userId ? { userId, organizationId: orgId ?? null } : undefined); }, [isLoaded, isSignedIn, userId, orgId]);
  return children;
}
