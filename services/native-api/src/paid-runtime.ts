import { attachDatabasePool } from '@vercel/functions';
import { createNativeTaskApp,createClerkIdentityObservationVerifier } from '@pactwoven/api/native-host';
import { createRuntimePool,PostgresFoundationRepository } from '@pactwoven/db';
import { createPaidToolPool } from '../../../packages/db/src/paid-tool-pool';
import { PostgresPaidToolHumanRepository } from '../../../packages/db/src/paid-tool-repository';
import { PostgresPaidToolRootRepository } from '../../../packages/db/src/paid-tool-root-repository';
import { PostgresPaidToolIntentRepository } from '../../../packages/db/src/paid-tool-intent-repository';
import { NativePaidQuoteService } from '../../api/src/native-paid-quote-service';
import { NativePaidEquipmentService } from '../../api/src/native-paid-equipment-service';
import { PostgresPaidToolContributorsRepository } from '../../../packages/db/src/paid-tool-contributors-repository';
import { PostgresPaidToolHistoryRepository } from '../../../packages/db/src/paid-tool-history-repository';
import { readNativePaidApiConfig } from './config';
import { nativeWorkApp } from './delegated-runtime';
type Pool=Awaited<ReturnType<typeof createRuntimePool>>;
type App=ReturnType<typeof createNativeTaskApp>;
const unavailable=()=>Error('Paid work initialization could not be confirmed.');
let initialized:Promise<App>|undefined;
async function closePools(pools:Pool[]){
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([Promise.allSettled(pools.map(async pool=>{await pool.end();})),
    new Promise<void>(resolve=>{timer=setTimeout(resolve,1000);})]);}finally{clearTimeout(timer);}
}
async function open(create:()=>Promise<Pool>,deadline:number){
  if(deadline<=Date.now())throw unavailable();let expired=false,timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([Promise.resolve().then(create).then(pool=>{if(expired||Date.now()>=deadline){void closePools([pool]);throw unavailable();}return pool;}),
    new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(unavailable());},deadline-Date.now());})]);}finally{clearTimeout(timer);}
}
/** Own pools and cache: unavailable paid services cannot take down text work,
 * memory or the original delegated authority verifier. */
export async function nativePaidWorkApp(deadlineAt=Date.now()+15000):Promise<App>{
  if(!Number.isSafeInteger(deadlineAt)||deadlineAt-Date.now()<1000)throw unavailable();
  const config=readNativePaidApiConfig(process.env);if(!config)return nativeWorkApp(deadlineAt);
  if(!initialized){const deadline=Math.min(Date.now()+10000,deadlineAt-1000);
    initialized=(async()=>{const owned:Pool[]=[];
      try{
        const foundation=await open(()=>createRuntimePool(config.foundationDatabaseUrl),deadline);owned.push(foundation);
        const paid=await open(()=>createPaidToolPool(config.paidDatabaseUrl,config.environment,'api'),deadline);owned.push(paid);
        const human=new PostgresPaidToolHumanRepository(paid),roots=new PostgresPaidToolRootRepository(paid);
        const app=createNativeTaskApp({allowedOrigins:config.allowedOrigins,repository:new PostgresFoundationRepository(foundation,config.environment),
          verifyObservedIdentity:createClerkIdentityObservationVerifier(config.identity),nativePaidWorkIntentRepository:new PostgresPaidToolIntentRepository(paid),
          nativePaidToolHumanRepository:human,nativePaidQuoteGateway:new NativePaidQuoteService(roots,human,{sourceKey:config.sourceKey,feeKey:config.feeKey}),
          nativePaidEquipmentReader:new NativePaidEquipmentService(roots,human),
          nativePaidContributorsReader:new PostgresPaidToolContributorsRepository(paid),
          nativePaidHistoryReader:new PostgresPaidToolHistoryRepository(paid),
          ...(config.allowNewWork?{nativePaidWorkOrganizationId:config.organizationId,nativePaidWorkPolicy:{serviceId:'equipment_optimizer_v1' as const,maximumComputationBaseUnits:'10000',maximumFeeLamports:'10000',authorization:'separate_quote_required' as const}}:{})});
        if(Date.now()>=deadline)throw unavailable();attachDatabasePool(foundation);attachDatabasePool(paid);return app;
      }catch{await closePools(owned);throw unavailable();}
    })().catch(error=>{initialized=undefined;throw error;});
  }
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([initialized,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(unavailable()),deadlineAt-Date.now());})]);}
  finally{clearTimeout(timer);}
}
