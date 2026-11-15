'use client';
import { createContext,useCallback,useContext,useLayoutEffect,useMemo,useRef,useState,type ReactNode } from 'react';
import type { AccessCapsule } from '../lib/access-capsule';
import { RequestError } from '../lib/api';
type RecoveryMemory={capsule:AccessCapsule|null;retain:(capsule:AccessCapsule)=>void;resolve:(key:string,kind?:AccessCapsule['original']['kind'])=>void;purge:()=>void;hasOriginal:()=>boolean;beginAction:(key:string,kind:'retry'|'close')=>(()=>void);inFlight:boolean};
const RecoveryMemoryContext=createContext<RecoveryMemory|null>(null);
// Private original input has its own lifecycle; it is never part of the minimal receipt or browser storage.
export function AccessRecoveryMemoryProvider({children}:{children:ReactNode}) {
  const current=useRef<AccessCapsule|null>(null);const alive=useRef(true);const [capsule,setCapsule]=useState<AccessCapsule|null>(null);
  const action=useRef<{key:string;kind:'retry'|'close'}|null>(null);const [inFlight,setInFlight]=useState(false);
  useLayoutEffect(()=>{alive.current=true;return()=>{alive.current=false;current.current=null;action.current=null;};},[]);
  const retain=useCallback((value:AccessCapsule)=>{if(!alive.current)throw new RequestError('RECOVERY_SCOPE_CHANGED','The authenticated recovery scope has ended.');if(action.current?.kind==='close'||(current.current&&(current.current.key!==value.key||current.current.integrityHash!==value.integrityHash)))throw new RequestError('ORIGINAL_REQUEST_PENDING','The original request is still unresolved.');current.current=value;setCapsule(value);},[]);
  const resolve=useCallback((key:string,kind?:AccessCapsule['original']['kind'])=>{if(current.current?.key===key&&(!kind||current.current.original.kind===kind)){current.current=null;if(alive.current)setCapsule(null);}},[]);
  const purge=useCallback(()=>{current.current=null;if(alive.current)setCapsule(null);},[]);
  const hasOriginal=useCallback(()=>current.current!==null,[]);
  const beginAction=useCallback((key:string,kind:'retry'|'close')=>{if(!alive.current||action.current)throw new RequestError('RECOVERY_ACTION_PENDING','Another recovery action is still being observed.');if(kind==='close'?current.current!==null:current.current?.key!==key)throw new RequestError('RECOVERY_INPUT_CHANGED','The original input availability changed. Check the original result again.');const ticket={key,kind};action.current=ticket;setInFlight(true);return()=>{if(action.current===ticket){action.current=null;if(alive.current)setInFlight(false);}};},[]);
  const value=useMemo(()=>({capsule,retain,resolve,purge,hasOriginal,beginAction,inFlight}),[capsule,retain,resolve,purge,hasOriginal,beginAction,inFlight]);
  return <RecoveryMemoryContext value={value}>{children}</RecoveryMemoryContext>;
}
export function useAccessRecoveryMemory(){const value=useContext(RecoveryMemoryContext);if(!value)throw new Error('Authenticated recovery memory is required');return value;}
