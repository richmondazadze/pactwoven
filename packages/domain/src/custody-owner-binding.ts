import { CustodyCommandSchema, CustodyRecordSchema, CustodySetupSpecificationSchema, CustodyUuidSchema, HashSchema, decodeSolanaBase58, encodeSolanaBase58,
  type CustodyCommand, type CustodyRecord, type CustodySetupSpecification, type CustodyWalletChallenge } from '@pactwoven/contracts';
import { canonicalJson, commandDigest } from './canonical.js';

const utf8 = (s:string) => new TextEncoder().encode(s);
const concat = (...v:Uint8Array[]) => Uint8Array.from(v.flatMap(x=>Array.from(x)));
const hashBytes = async (v:Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(v)));
const hex = (v:Uint8Array) => Array.from(v,b=>b.toString(16).padStart(2,'0')).join('');
const uuidBytes = (v:string) => Uint8Array.from(v.replaceAll('-','').match(/../g)!,b=>Number.parseInt(b,16));
const p = (1n<<255n)-19n;
const mod = (n:bigint) => ((n%p)+p)%p;
function pow(n:bigint,e:bigint):bigint {let r=1n;for(n=mod(n);e;e>>=1n,n=mod(n*n))if(e&1n)r=mod(r*n);return r;}
/** Pure address derivation only. No RPC, wallet, transaction or signer capability. */
function onCurve(bytes:Uint8Array):boolean {
  let y=0n;for(let i=31;i>=0;i--)y=(y<<8n)|BigInt(i===31?bytes[i]!&127:bytes[i]!);
  const yy=mod(y*y),d=mod(-121665n*pow(121666n,p-2n));
  const x2=mod((yy-1n)*pow(d*yy+1n,p-2n));return x2===0n||pow(x2,(p-1n)/2n)===1n;
}
export async function deriveCustodyAddress(program:string,seeds:readonly Uint8Array[]):Promise<string> {
  if(seeds.length>15||seeds.some(s=>!(s instanceof Uint8Array)||s.length>32))throw new TypeError('Invalid PDA seeds.');
  for(let bump=255;bump>=0;bump--){const bytes=await hashBytes(concat(...seeds,Uint8Array.of(bump),decodeSolanaBase58(program,32),utf8('ProgramDerivedAddress')));if(!onCurve(bytes))return encodeSolanaBase58(bytes);}
  throw new TypeError('No canonical PDA.');
}
export async function custodySetupAddresses(program:string,organizationUuid:string,responsibilityUuid:string,assetKey:string) {
  CustodyUuidSchema.parse(organizationUuid);CustodyUuidSchema.parse(responsibilityUuid);HashSchema.parse(assetKey);
  const organizationKey=await hashBytes(concat(utf8('pactwoven:org-registration:v1\0'),uuidBytes(organizationUuid)));
  const responsibilityKey=await hashBytes(concat(utf8('pactwoven:responsibility-registration:v1\0'),uuidBytes(organizationUuid),uuidBytes(responsibilityUuid)));
  const asset=Uint8Array.from(assetKey.match(/../g)!,b=>Number.parseInt(b,16));
  const configAddress=await deriveCustodyAddress(program,[utf8('pw:config:v1')]);
  const registrationAddress=await deriveCustodyAddress(program,[utf8('pw:custody:v1'),organizationKey,responsibilityKey,asset]);
  const vaultAddress=await deriveCustodyAddress(program,[utf8('pw:vault:v1'),decodeSolanaBase58(registrationAddress,32)]);
  const setupOperationKey=hex(await hashBytes(concat(utf8('pactwoven:custody-setup-op:v1\0'),decodeSolanaBase58(program,32),decodeSolanaBase58(registrationAddress,32))));
  return {configAddress,registrationAddress,vaultAddress,setupOperationKey};
}
export async function validateCustodySpecification(input:CustodySetupSpecification):Promise<CustodySetupSpecification> {
  const s=CustodySetupSpecificationSchema.parse(input);
  const addresses=await custodySetupAddresses(s.program.id,s.organization.registrationUuid,s.responsibility.registrationUuid,s.asset.key);
  if(addresses.configAddress!==s.config.address||addresses.registrationAddress!==s.registrationAddress||addresses.vaultAddress!==s.vaultAddress||addresses.setupOperationKey!==s.setupOperationKey||
    await commandDigest({namespace:'pactwoven:financial-authority-fence:v1',record:s.authority.snapshot})!==s.authority.recordHash)throw new TypeError('Custody specification has inconsistent derived scope.');
  return s;
}
export async function custodySpecificationHash(s:CustodySetupSpecification):Promise<string>{return commandDigest({namespace:'pactwoven:custody-setup-specification:v1',record:await validateCustodySpecification(s)});}
export async function custodyRecordHash(input:CustodyRecord):Promise<string>{const r=CustodyRecordSchema.parse(input);return commandDigest({namespace:r.kind==='owner_binding'?'pactwoven:custody-owner-binding:v1':`pactwoven:custody-${r.kind}:v1`,record:r});}
export async function custodyCommandHash(organizationId:string,actorId:string,input:CustodyCommand):Promise<string>{const command=CustodyCommandSchema.parse(input);
  return commandDigest({namespace:'pactwoven:custody-command:v1',record:{environment:'development',organizationId,actorId,command}});}
export function custodyWalletChallengeBytes(input:CustodyWalletChallenge):Uint8Array{return concat(utf8('pactwoven:custody-owner-challenge:v1\0'),utf8(canonicalJson(CustodyRecordSchema.parse(input))));}
