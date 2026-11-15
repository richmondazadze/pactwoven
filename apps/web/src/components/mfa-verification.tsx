'use client';
import { useAuth, useClerk, useSession, useUser } from '@clerk/nextjs';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { verificationStage, type VerificationView } from '../lib/mfa';
import { ActionLabel, Alert } from './ui';
import { Icon } from './icon';
import { useArrival } from './motion';
type Stage = 'start' | 'password' | 'totp' | 'complete' | 'unsupported';
export function MfaVerification({ onComplete, onInvalidated, purpose = 'access-change' }: { onComplete: () => void; onInvalidated?: () => void; purpose?: 'access-change' | 'account-check' | 'mandate-authorization' | 'access-recovery-close' }) {
  const fieldId=useId();const errorId=useId();const mandate=purpose==='mandate-authorization';const closure=purpose==='access-recovery-close';
  const auth=useAuth(); const { session } = useSession(); const { user } = useUser(); const clerk = useClerk();
  const [stage,setStage] = useState<Stage>('start'); const [busy,setBusy] = useState(false); const [error,setError] = useState('');
  const [password,setPassword] = useState(''); const [code,setCode] = useState('');
  const generation = useRef(0); const locked = useRef(false); const input = useRef<HTMLInputElement>(null);
  const arrival = useArrival(stage,120); const invalidation=useRef(onInvalidated);
  useEffect(()=>{invalidation.current=onInvalidated;},[onInvalidated]);
  useEffect(() => { generation.current++;locked.current=false;setBusy(false);setPassword('');setCode('');setError('');setStage('start');invalidation.current?.();return () => { generation.current++; }; },[session?.id,auth.userId,auth.orgId]);
  useEffect(() => { if (!busy && (stage==='password' || stage==='totp')) input.current?.focus({preventScroll:true}); },[stage,error,busy]);
  function receive(result: VerificationView) {
    const next=verificationStage(result); setStage(next);
    if(next==='complete') onComplete();
  }
  async function run(action: 'start' | 'password' | 'totp') {
    if (locked.current || !session) return;
    if (!user?.totpEnabled) { setStage('unsupported'); return; }
    const ticket=generation.current; locked.current=true; setBusy(true);setError('');
    try {
      const pending=action==='start' ? session.startVerification({level:'multi_factor'}) : action==='password' ? session.attemptFirstFactorVerification({strategy:'password',password}) : session.attemptSecondFactorVerification({strategy:'totp',code});
      setPassword('');setCode('');
      const result=await pending;
      if (ticket===generation.current) receive(result);
    } catch {
      if(ticket===generation.current) setError(action==='start' ? 'Verification could not start. Check your sign-in and try again.' : 'That verification could not be completed. Enter a fresh value and try again.');
    } finally { if(ticket===generation.current) {locked.current=false;setBusy(false);} }
  }
  function cancel() { generation.current++; locked.current=false;setBusy(false);setPassword('');setCode('');setError('');setStage('start'); }
  function submit(event: FormEvent) { event.preventDefault(); if(stage==='password' || stage==='totp') void run(stage); }
  if (!session || !user) return <Alert title="Sign-in verification unavailable" tone="red"><p>{closure?'Sign in again before closing this request key. No closure has been sent.':mandate?'Sign in again before authorizing this mandate. No mandate decision has been sent.':'Sign in again before changing access. No access command has been sent.'}</p></Alert>;
  return <div className="mfa-verification" ref={arrival} aria-busy={busy}>
    <div className="security-feature"><span><Icon name="shield-lock" size={24}/></span><div><h3>Verify both factors</h3><p>{purpose==='account-check'?'Check your password and authenticator together. This check does not change organization access.':closure?'Your password and authenticator protect this administrative request-key closure. The service checks your current owner authority and fresh closure-specific verification when you submit.':mandate?'Your password and authenticator protect this exact mandate authorization. The service checks your current authority and both factors again when you submit.':'Your password and authenticator protect this exact access change. The service checks current authority and verification again when you submit.'}</p></div></div>
    {(!user.totpEnabled || stage==='unsupported') ? <Alert title={!user.totpEnabled ? 'Set up an authenticator first' : 'This verification method is not supported'} tone="amber"><p>{!user.totpEnabled ? (closure?'This account needs an authenticator app before it can close a request key.':mandate?'This account needs an authenticator app before it can authorize a mandate.':'This account needs an authenticator app before it can submit an access change.') : 'This flow requires password and authenticator verification. A first-factor-only result cannot unlock the change.'}</p><button type="button" className="button secondary" onClick={()=>clerk.openUserProfile()}>Manage account security</button><p className="fine">Return here after setup and start verification again.</p>{user.totpEnabled && <button type="button" className="text-action" onClick={cancel}>Start again</button>}</Alert> : stage==='start' ? <button type="button" className="button secondary" disabled={busy} onClick={()=>void run('start')}><Icon name="key"/><ActionLabel label={busy ? 'Starting verification…' : 'Verify identity'} reserve={['Starting verification…','Verify identity']}/></button> : stage==='complete' ? <Alert title="Factors checked by your sign-in provider" tone="blue"><p>{purpose==='account-check'?'This checks the sign-in flow only. No access change was submitted or authorized.':closure?'No request key has been closed. Use the separate close action when you are ready; the service must still verify the evidence.':mandate?'No mandate decision has been submitted. Use the separate authorization action when you are ready; the service must still verify the evidence.':'No access change has been submitted. Use the separate submit action when you are ready; the service must still verify the evidence.'}</p></Alert> : <form onSubmit={submit} className="verification-form">
      <p className="verification-step">{stage==='password' ? '1 · Confirm your password' : '2 · Enter an authenticator code'}</p>
      <label className="field" htmlFor={fieldId}>{stage==='password' ? 'Password' : 'Six-digit code'}<input key={stage} id={fieldId} ref={input} type={stage==='password' ? 'password' : 'text'} inputMode={stage==='totp' ? 'numeric' : undefined} autoComplete={stage==='password' ? 'current-password' : 'one-time-code'} value={stage==='password' ? password : code} onChange={event=>stage==='password' ? setPassword(event.target.value) : setCode(event.target.value.replace(/\D/g,'').slice(0,6))} maxLength={stage==='totp' ? 6 : 1024} disabled={busy} required aria-invalid={Boolean(error)} aria-describedby={error?errorId:undefined}/></label>
      <div className="actions"><button className="button secondary" type="submit" disabled={busy || (stage==='password' ? !password : code.length!==6)}><ActionLabel label={busy ? 'Checking…' : stage==='password' ? 'Continue verification' : 'Check authenticator code'} reserve={['Continue verification','Check authenticator code']}/></button><button className="text-action" type="button" onClick={cancel}>Cancel verification</button></div>
    </form>}
    {error && <div id={errorId}><Alert title="Verification needs attention" tone="red"><p>{error}</p></Alert></div>}
  </div>;
}
