'use client';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Operation, Session } from '@pactwoven/contracts';
import { accessNoticeFromOperation, type AccessNotice } from '../lib/access-feedback';
type AccessFeedback = { notice: AccessNotice | null; record: (session: Session, operation: Operation) => void; dismiss: () => void };
const AccessFeedbackContext = createContext<AccessFeedback | null>(null);
// The parent is keyed by Clerk user, organization and session. This provider intentionally
// outlives only the inner authorization-scope remount; it never persists to browser storage.
export function AccessFeedbackProvider({ children }: { children: ReactNode }) {
  const [notice,setNotice]=useState<AccessNotice|null>(null);
  const record=useCallback((session:Session,operation:Operation)=>setNotice(accessNoticeFromOperation(session,operation)),[]);
  const dismiss=useCallback(()=>setNotice(null),[]);
  const value=useMemo(()=>({notice,record,dismiss}),[notice,record,dismiss]);
  return <AccessFeedbackContext value={value}>{children}</AccessFeedbackContext>;
}
export function useAccessFeedback() { const value=useContext(AccessFeedbackContext);if(!value)throw new Error('Session-scoped access feedback is required');return value; }
