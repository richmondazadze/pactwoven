import {z} from 'zod';
import {IdSchema,BaseUnitsSchema} from '../../../packages/contracts/src/core';
import {SolanaPublicKeySchema} from '../../../packages/contracts/src/finance-provenance';
const lanes=['policy','broadcaster','observer','delivery','scheduler'] as const;
const Route=z.strictObject({sourceKey:IdSchema,feeKey:IdSchema,sourceAccount:SolanaPublicKeySchema,sourceOwner:SolanaPublicKeySchema,destinationAccount:SolanaPublicKeySchema,destinationOwner:SolanaPublicKeySchema,feePayer:SolanaPublicKeySchema,minimumSlot:BaseUnitsSchema});
export function paidHostEnabled(values:Record<string,string|undefined>){
 if(values.PAID_TOOL_SOURCE_PRIVATE_KEY||values.PAID_TOOL_SIGNER_DATABASE_URL||values.SIGNER_PRIVATE_KEY)throw Error('Paid executor credential isolation failed.');
 if(values.PAID_TOOL_RUNTIME_ENABLED!==undefined&&!['true','false'].includes(values.PAID_TOOL_RUNTIME_ENABLED))throw Error('Paid runtime is not configured.');
 return values.PAID_TOOL_RUNTIME_ENABLED==='true';
}
function database(value:string|undefined){const u=new URL(z.string().min(1).max(8192).parse(value));if(!['postgres:','postgresql:'].includes(u.protocol)||!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.neon\.tech$/.test(u.hostname)||u.pathname!=='/pactwoven_dev'||u.port&&u.port!=='5432'||u.hash||!u.username||!u.password||u.searchParams.get('sslmode')!=='verify-full')throw Error();
 if(!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(decodeURIComponent(u.username))||/[\r\n\0]/.test(decodeURIComponent(u.password)))throw Error();const seen=new Set<string>();for(const[k,v]of u.searchParams){if(seen.has(k)||!['sslmode','channel_binding'].includes(k)||k==='sslmode'&&v!=='verify-full'||k==='channel_binding'&&v!=='require')throw Error();seen.add(k);}return u;}
export function readPaidHostConfig(values:Record<string,string|undefined>){try{
 if(!paidHostEnabled(values)||values.APP_ENVIRONMENT!=='development')throw Error();
 const organizationId=IdSchema.parse(values.PAID_TOOL_ORGANIZATION_ID);
 const urls=Object.fromEntries(lanes.map(lane=>[lane,database(values['PAID_TOOL_'+lane.toUpperCase()+'_DATABASE_URL'])])) as Record<typeof lanes[number],URL>;
 const all=Object.values(urls),location=(u:URL)=>u.hostname.replace('-pooler.','.')+u.pathname;
 if(new Set(all.map(u=>decodeURIComponent(u.username))).size!==5||new Set(all.map(location)).size!==1)throw Error();
 for(const[name,value]of Object.entries(values))if(value&&name.endsWith('DATABASE_URL')&&!lanes.some(l=>'PAID_TOOL_'+l.toUpperCase()+'_DATABASE_URL'===name)){const u=new URL(value);if(all.some(p=>decodeURIComponent(p.username)===decodeURIComponent(u.username)))throw Error();}
 const routes=z.array(Route).length(1).parse(JSON.parse(z.string().max(8192).parse(values.PAID_TOOL_CUSTODY_ROUTES))),r=routes[0]!;
 if(r.sourceOwner!==r.feePayer||r.sourceAccount===r.destinationAccount||r.sourceOwner===r.destinationOwner||r.sourceKey===r.feeKey)throw Error();
 const signerOrigin=z.string().regex(/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/).parse(values.PAID_TOOL_SIGNER_ORIGIN);
 const endpoint=new URL(z.string().max(8192).parse(values.QUICKNODE_DEVNET_RPC_URL));if(endpoint.protocol!=='https:'||!/^[a-z0-9][a-z0-9-]*\.(?:solana-devnet\.)?quiknode\.pro$/.test(endpoint.hostname)||endpoint.username||endpoint.password||endpoint.port||endpoint.search||endpoint.hash||!/^\/[A-Za-z0-9_-]+\/?$/.test(endpoint.pathname))throw Error();
 return {environment:'development' as const,organizationId,databases:Object.fromEntries(lanes.map(l=>[l,urls[l].href])) as Record<typeof lanes[number],string>,routes,signerOrigin,endpointUrl:endpoint.href};
}catch{throw Error('Paid runtime is not configured.');}}
export type PaidHostConfig=ReturnType<typeof readPaidHostConfig>;
