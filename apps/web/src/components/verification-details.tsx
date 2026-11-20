import type { ReactNode } from 'react';
import { Icon } from './icon';
import '../app/support-details.css';

/** Exact, non-secret record provenance; approval terms belong outside this disclosure. */
export function VerificationDetails({ children, label = 'Verification details' }: { children: ReactNode; label?: string }) {
  return <details className="support-disclosure verification-details"><summary>{label}<Icon name="chevron-down" size={15}/></summary>{children}</details>;
}
