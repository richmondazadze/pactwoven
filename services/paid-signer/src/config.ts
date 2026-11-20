import {createPrivateKey,createPublicKey,type KeyObject} from 'node:crypto';
import {z} from 'zod';
import {IdSchema,BaseUnitsSchema} from '../../../packages/contracts/src/core';
import {SolanaPublicKeySchema,encodeSolanaBase58} from '../../../packages/contracts/src/finance-provenance';
import {VercelWorkloadIdentitySchema} from '../../../packages/service-identity/src/index';
const Route=z.strictObject({sourceKey:IdSchema,feeKey:IdSchema,sourceAccount:SolanaPublicKeySchema,sourceOwner:SolanaPublicKeySchema,destinationAccount:SolanaPublicKeySchema,destinationOwner:SolanaPublicKeySchema,feePayer:SolanaPublicKeySchema,minimumSlot:BaseUnitsSchema});
const required=(x:string|undefined,max=8192)=>z.string().min(1).max(max).parse(x);
export function readPaidSignerConfig(values:Record<string,string|undefined>){
 try{
  for(const [name,value] of Object.entries(values))if(value&&(
   name.endsWith('DATABASE_URL')&&name!=='PAID_TOOL_SIGNER_DATABASE_URL'||
   /(?:PRIVATE_KEY|SECRET_KEY|KEYPAIR|API_KEY|VAULT|^AZURE_|^NATIVE_|^CLERK_|^GOOGLE_)/.test(name)&&name!=='PAID_TOOL_SOURCE_PRIVATE_KEY'))throw Error('Credential isolation');
  if(values.APP_ENVIRONMENT!=='development')throw Error('Environment');
  const database=new URL(required(values.PAID_TOOL_SIGNER_DATABASE_URL));
  if(!['postgres:','postgresql:'].includes(database.protocol)||!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.neon\.tech$/.test(database.hostname)||database.pathname!=='/pactwoven_dev'||database.hash||database.port&&database.port!=='5432'||!database.username||!database.password||database.searchParams.get('sslmode')!=='verify-full')throw Error('Database');
  if(!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(decodeURIComponent(database.username))||/[\r\n\0]/.test(decodeURIComponent(database.password)))throw Error('Database');
  const seen=new Set<string>();for(const [k,v] of database.searchParams){if(seen.has(k)||!['sslmode','channel_binding'].includes(k)||k==='sslmode'&&v!=='verify-full'||k==='channel_binding'&&v!=='require')throw Error('Database');seen.add(k);}
  const endpoint=new URL(required(values.QUICKNODE_DEVNET_RPC_URL));
  if(endpoint.protocol!=='https:'||!/^[a-z0-9][a-z0-9-]*\.(?:solana-devnet\.)?quiknode\.pro$/.test(endpoint.hostname)||endpoint.port||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!/^\/[A-Za-z0-9_-]+\/?$/.test(endpoint.pathname))throw Error('RPC');
  const routes=z.array(Route).length(1).parse(JSON.parse(required(values.PAID_TOOL_CUSTODY_ROUTES))),route=routes[0]!;
  if(route.sourceOwner!==route.feePayer||route.sourceAccount===route.destinationAccount||route.sourceOwner===route.destinationOwner||route.sourceKey===route.feeKey)throw Error('Custody');
  const executor=VercelWorkloadIdentitySchema.parse(JSON.parse(required(values.PAID_TOOL_EXECUTOR_IDENTITY)));
  const privateKey=required(values.PAID_TOOL_SOURCE_PRIVATE_KEY,256);if(!/^[A-Za-z0-9+/]+={0,2}$/.test(privateKey))throw Error('Key encoding');
  return {environment:'development' as const,databaseUrl:database.href,endpointUrl:endpoint.href,routes,executor,privateKey};
 }catch{throw Error('Paid signer is not configured.');}
}
export type PaidSignerConfig=ReturnType<typeof readPaidSignerConfig>;
/** Called only inside the isolated signer host. No real key is read at import. */
export function paidSignerKey(config:PaidSignerConfig):KeyObject{
 try{const bytes=Buffer.from(config.privateKey,'base64');if(bytes.toString('base64')!==config.privateKey||bytes.length!==48)throw Error();
  let key:KeyObject;try{key=createPrivateKey({key:bytes,format:'der',type:'pkcs8'});}finally{bytes.fill(0);}
  if(key.type!=='private'||key.asymmetricKeyType!=='ed25519'||encodeSolanaBase58(createPublicKey(key).export({format:'der',type:'spki'}).subarray(-32))!==config.routes[0]!.sourceOwner)throw Error();return key;
 }catch{throw Error('Paid signer custody is not configured.');}
}
