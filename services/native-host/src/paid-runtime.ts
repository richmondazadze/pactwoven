import type {Pool} from 'pg';
import {attachDatabasePool} from '@vercel/functions';
import {getVercelOidcToken} from '@vercel/functions/oidc';
import {createPaidToolPool,type PaidToolPoolLane} from '../../../packages/db/src/paid-tool-pool';
import {PostgresPaidToolPrivateRepository} from '../../../packages/db/src/paid-tool-repository';
import {PostgresPaidToolEvidenceRepository,PostgresPaidToolDispatchRepository} from '../../../packages/db/src/paid-tool-dispatch-repository';
import {PostgresPaidToolRootRepository} from '../../../packages/db/src/paid-tool-root-repository';
import {PaidToolPrivateReadSchema} from '../../../packages/db/src/paid-tool-schema';
import {DelegatedPaidEquipmentCoordinator} from '../../coordinator/src/delegated-paid-equipment';
import {PrivateEquipmentQuoteProducer} from '../../paid-tools/src/equipment-quote';
import {paidDemoDefinition} from '../../paid-tools/src/demo-definition';
import {PrivatePaidToolBroadcaster,PrivatePaidToolFinalityObserver} from '../../paid-tools/src/solana-execution';
import {PrivatePaidToolFundingPolicy} from '../../paid-tools/src/funding-policy';
import {PrivateEquipmentDelivery} from '../../paid-tools/src/equipment-delivery';
import {QuickNodePaidToolTransport} from '../../paid-tools/src/solana-transport';
import {PaidToolOperationDriver} from '../../paid-tools/src/paid-loop';
import {createPaidRpcEvidenceSink} from '../../paid-tools/src/host-evidence';
import {createPrivateSignerClient} from '../../paid-tools/src/private-signer-client';
import {PaidToolQueueMessageSchema,publishPaidToolWork,consumePaidToolWork,type PaidToolQueueSend} from '../../paid-tools/src/host-queue';
import {paidHostEnabled,readPaidHostConfig,type PaidHostConfig} from './paid-config';
import {sendPaidQueueMessage} from './paid-dispatch';
import {NativeDeliveryRetry} from './consume';
type Lane='policy'|'broadcaster'|'observer'|'delivery'|'scheduler';
type Pools=Record<Lane,Pick<Pool,'query'>>;
export function composePaidOperationDriver(config:PaidHostConfig,pools:Pools,options:{token:()=>Promise<string>;fetch?:typeof fetch}){
 const repos=Object.fromEntries(Object.entries(pools).map(([lane,pool])=>[lane,new PostgresPaidToolPrivateRepository(pool)])) as Record<Lane,PostgresPaidToolPrivateRepository>;
 const signer=createPrivateSignerClient(config.signerOrigin,options);
 const read=async(id:string)=>{const r=PaidToolPrivateReadSchema.parse(await repos.policy.read(id));if(r.snapshot.review.organizationId!==config.organizationId)throw Error('Paid operation scope mismatch');return r;};
 // Per-operation evidence is bound to the stored operation before any RPC call.
 return {advance:async(id:string,signal:AbortSignal)=>{
  const transport=(lane:Lane)=>new QuickNodePaidToolTransport({endpointUrl:config.endpointUrl,...(options.fetch?{fetch:options.fetch}:{}),capture:createPaidRpcEvidenceSink(id,new PostgresPaidToolEvidenceRepository(pools[lane]))});
  const funding=new PrivatePaidToolFundingPolicy(repos.policy,repos.observer,transport('policy'),config.routes),broadcaster=new PrivatePaidToolBroadcaster(repos.broadcaster,repos.observer,transport('broadcaster'),config.routes,v=>repos.broadcaster.recordHeight(v)),observer=new PrivatePaidToolFinalityObserver(repos.observer,transport('observer'),config.routes),delivery=new PrivateEquipmentDelivery(repos.delivery);
  return new PaidToolOperationDriver({read,fundAndReserve:(op,s)=>funding.fundAndReserve(op,s),sign:(op,s)=>signer.prepareAndSign(op,s),recoverSigned:(op,s)=>signer.recoverRetained(op,s),broadcast:(op,s)=>broadcaster.broadcast(op,s),reconcile:(op,s)=>observer.reconcile(op,s),deliver:(op,s)=>delivery.deliver(op,s)}).advance(id,signal);
 }};
}
export function createPaidHostRuntime(options:{values:()=>Record<string,string|undefined>;openPool?:typeof createPaidToolPool;attach?:(pool:Pool)=>void;send?:PaidToolQueueSend;token?:()=>Promise<string>;fetch?:typeof fetch;now?:()=>number}){
 const now=options.now??Date.now,initialized=new Map<Lane,Promise<Pool>>();let configured:PaidHostConfig|undefined;
 const enabled=()=>paidHostEnabled(options.values()),config=()=>configured??=readPaidHostConfig(options.values());
 async function pool(lane:Lane,deadlineAt:number){
  if(deadlineAt-now()<5000)throw new NativeDeliveryRetry();
  let pending=initialized.get(lane);if(pending)return pending;
  let expired=false,timer:ReturnType<typeof setTimeout>|undefined;const until=Math.min(deadlineAt-5000,now()+20000);
  pending=(async()=>{const opening=(options.openPool??createPaidToolPool)(config().databases[lane],'development',lane as PaidToolPoolLane).then(p=>{if(expired||now()>=until){void p.end().catch(()=>{});throw new NativeDeliveryRetry();}try{options.attach?.(p);}catch{void p.end().catch(()=>{});throw new NativeDeliveryRetry();}return p;});
   try{return await Promise.race([opening,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(new NativeDeliveryRetry());},Math.max(1,until-now()));})]);}
   finally{clearTimeout(timer);}
  })().catch(()=>{initialized.delete(lane);throw new NativeDeliveryRetry();});initialized.set(lane,pending);return pending;
 }
 const dispatcher=async(deadlineAt:number)=>new PostgresPaidToolDispatchRepository(await pool('scheduler',deadlineAt));
 const publish=async(deadlineAt:number)=>{if(!enabled())return {accepted:0,unconfirmed:0};if(deadlineAt-now()<20000)throw new NativeDeliveryRetry();const repository=await dispatcher(deadlineAt);if(deadlineAt-now()<20000)throw new NativeDeliveryRetry();const result=await publishPaidToolWork({repository,send:options.send??sendPaidQueueMessage,deadlineAt,now});if(result.unconfirmed)throw new NativeDeliveryRetry();return result;};
 return {enabled,publish,
  async recover(deadlineAt:number){if(!enabled()||deadlineAt-now()<20000)return {recovered:0};const repository=await dispatcher(deadlineAt);const recovered=await repository.recover({limit:20});await publish(deadlineAt);return {recovered};},
  async coordinator(coordinatorPool:Pick<Pool,'query'>,deadlineAt:number){if(!enabled())return undefined;const settings=config(),definition=await paidDemoDefinition(settings.routes[0]!.destinationOwner);
   // Opening a paid policy pool is deferred until an opted-in root actually
   // proposes its quote; ordinary advisory roots retain their existing path.
   return {beforeSynthesis:(async(context)=>{if(context.scope.organizationId!==settings.organizationId)return {kind:'ordinary' as const};
    const quote={propose:async(input:Parameters<PrivateEquipmentQuoteProducer['propose']>[0],signal:AbortSignal)=>{signal.throwIfAborted();const policy=new PostgresPaidToolPrivateRepository(await pool('policy',context.lease.usableUntil));signal.throwIfAborted();return new PrivateEquipmentQuoteProducer(policy,definition).propose(input,signal);}};
    const bridge=new DelegatedPaidEquipmentCoordinator({repository:new PostgresPaidToolRootRepository(coordinatorPool),quote,catalogue:definition.catalogue});return bridge.beforeSynthesis(context);
   }) as DelegatedPaidEquipmentCoordinator['beforeSynthesis']};
  },
  async consume(payload:unknown,deadlineAt:number):Promise<'discarded'|'settled'>{const parsed=PaidToolQueueMessageSchema.safeParse(payload);if(!parsed.success)return 'discarded';if(!enabled()||deadlineAt-now()<75000)throw new NativeDeliveryRetry();
   await publish(deadlineAt);
   const entries=await Promise.all((['policy','broadcaster','observer','delivery','scheduler'] as const).map(async lane=>[lane,await pool(lane,deadlineAt)] as const)),pools=Object.fromEntries(entries) as Record<Lane,Pool>;
   const driver=composePaidOperationDriver(config(),pools,{token:options.token??getVercelOidcToken,...(options.fetch?{fetch:options.fetch}:{})});
   const result=await consumePaidToolWork(parsed.data,{repository:new PostgresPaidToolDispatchRepository(pools.scheduler),driver,deadlineAt,now});
   if(result==='unconfirmed')throw new NativeDeliveryRetry();if(result==='discarded')return 'discarded';
   if(deadlineAt-now()<20000)throw new NativeDeliveryRetry();await publish(deadlineAt);return 'settled';
  },
 };
}
const paidHost=createPaidHostRuntime({values:()=>process.env,attach:attachDatabasePool});
export const publishPaidHostWork=(deadlineAt:number)=>paidHost.publish(deadlineAt);
export const recoverPaidHostWork=(deadlineAt:number)=>paidHost.recover(deadlineAt);
export const runPaidQueueMessage=(payload:unknown,deadlineAt:number)=>paidHost.consume(payload,deadlineAt);
export const paidCoordinatorBridge=(pool:Pick<Pool,'query'>,deadlineAt:number)=>paidHost.coordinator(pool,deadlineAt);
