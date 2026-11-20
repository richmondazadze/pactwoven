import type {Pool} from 'pg';
import {createVercelWorkloadVerifier} from '../../../packages/service-identity/src/index';
import {createPaidToolPool} from '../../../packages/db/src/paid-tool-pool';
import {PostgresPaidToolPrivateRepository} from '../../../packages/db/src/paid-tool-repository';
import {PostgresPaidToolEvidenceRepository} from '../../../packages/db/src/paid-tool-dispatch-repository';
import {PrivatePaidToolSigner} from '../../paid-tools/src/solana-execution';
import {QuickNodePaidToolTransport} from '../../paid-tools/src/solana-transport';
import {createPaidRpcEvidenceSink} from '../../paid-tools/src/host-evidence';
import {createPrivateSignerHandler} from '../../paid-tools/src/private-signer-handler';
import {readPaidSignerConfig,paidSignerKey,type PaidSignerConfig} from './config';
export function createPaidSignerRuntime(options:{values:()=>Record<string,string|undefined>;attach?:(pool:Pool)=>void;openPool?:typeof createPaidToolPool;verifyFactory?:typeof createVercelWorkloadVerifier}){
 let config:PaidSignerConfig|undefined,verifier:ReturnType<typeof createVercelWorkloadVerifier>|undefined,initialized:Promise<{config:PaidSignerConfig;pool:Pool;key:ReturnType<typeof paidSignerKey>}>|undefined;
 const settings=()=>config??=readPaidSignerConfig(options.values());
 const resources=()=>initialized??=(async()=>{const config=settings(),key=paidSignerKey(config),pool=await(options.openPool??createPaidToolPool)(config.databaseUrl,'development','signer');try{options.attach?.(pool);return {config,pool,key};}catch{await pool.end().catch(()=>{});throw Error();}})().catch(()=>{initialized=undefined;throw Error('Paid signer resources unavailable.');});
 const signer=async(operationId:string)=>{const {config,pool,key}=await resources(),repository=new PostgresPaidToolPrivateRepository(pool),evidence=new PostgresPaidToolEvidenceRepository(pool);
  const transport=new QuickNodePaidToolTransport({endpointUrl:config.endpointUrl,capture:createPaidRpcEvidenceSink(operationId,evidence)});
  return new PrivatePaidToolSigner(repository,{observe:input=>evidence.observeForOperation(operationId,input)},transport,config.routes,new Map([[config.routes[0]!.sourceOwner,key]]));};
 return createPrivateSignerHandler({verifyExecutor:request=>{verifier??=(options.verifyFactory??createVercelWorkloadVerifier)(settings().executor);return verifier(request);},signer:{prepareAndSign:async(id,signal)=>(await signer(id)).prepareAndSign(id,signal),recoverRetained:async(id,signal)=>(await signer(id)).recoverRetained(id,signal)}});
}
