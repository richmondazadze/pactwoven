import {createPublicKey,verify,createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {CustodyRefSchema,CustodyWalletChallengeSchema,decodeSolanaBase58,type CustodyWalletChallenge} from '@pactwoven/contracts';
import {commandDigest,custodyRecordHash,custodyWalletChallengeBytes} from '@pactwoven/domain';
import {CustodyAuthEvidenceSchema,type CustodyAuthEvidence} from './custody-setup-auth-evidence.js';
import {custodyOutcomeUnknown,custodyTransaction} from './custody-setup-repository.js';
/** Verify the actual wallet message before handing its private attestation to storage. */
export async function verifyCustodyWalletEvidence(input:CustodyAuthEvidence,challengeInput:CustodyWalletChallenge){
  const e=CustodyAuthEvidenceSchema.parse(input),c=CustodyWalletChallengeSchema.parse(challengeInput);
  if(e.kind!=='wallet'||e.setupId!==c.setupId||e.challenge.id!==c.id||e.challenge.version!==c.version||e.challenge.recordHash!==await custodyRecordHash(c)||
    e.organizationId!==c.organizationId||JSON.stringify(e.owner)!==JSON.stringify(c.owner))throw new TypeError('Exact wallet challenge required.');
  const signature=Buffer.from(e.signature,'base64');
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(decodeSolanaBase58(c.wallet,32))]),format:'der',type:'spki'});
  if(createHash('sha256').update(signature).digest('hex')!==e.signatureHash||!verify(null,custodyWalletChallengeBytes(c),key,signature))throw new TypeError('Invalid wallet signature.');return e;
}
/** This private login trusts its verifier. It must never be available to browsers or the setup writer. */
export class PostgresCustodySetupAuthenticationRepository{
  constructor(private readonly pool:Pool){}
  async append(input:CustodyAuthEvidence,challenge?:CustodyWalletChallenge){let e=CustodyAuthEvidenceSchema.parse(input);
    if(e.kind==='wallet'){if(!challenge)throw new TypeError('Exact wallet challenge required.');e=await verifyCustodyWalletEvidence(e,challenge);}
    const hash=await commandDigest({namespace:'pactwoven:custody-auth-evidence:v1',record:e});
    return custodyTransaction(this.pool,'verifier',async c=>{const row=await c.query('SELECT pactwoven.custody_setup_attest($1::jsonb) AS response',[JSON.stringify(e)]),r=CustodyRefSchema.parse(row.rows[0]?.response);
      if(r.id!==e.id||r.version!==1||r.recordHash!==hash)throw custodyOutcomeUnknown();return r;});
  }
}
