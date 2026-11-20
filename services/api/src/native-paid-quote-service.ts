import { z } from 'zod';
import type { Session } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import { FINANCE_DEVNET_ASSET } from '../../../packages/contracts/src/finance-provenance';
import { commandDigest } from '../../../packages/contracts/src/canonical';
import { NativePaidQuoteViewSchema, NativePaidQuoteReviewSchema, NativePaidQuoteDiscoverySchema } from '../../../packages/contracts/src/native-paid-quote';
import { PaidToolRootDiscoverySchema, PaidToolRootQuoteSchema } from '../../../packages/db/src/paid-tool-root-schema';
import { PaidToolHumanSnapshotSchema, PaidToolHumanRecoverySchema, PaidToolReviewSchema } from '../../../packages/db/src/paid-tool-schema';
import type { PostgresPaidToolRootRepository } from '../../../packages/db/src/paid-tool-root-repository';
import type { PostgresPaidToolHumanRepository } from '../../../packages/db/src/paid-tool-repository';
import { equipmentRequestHash, equipmentResourceHash } from '../../paid-tools/src/equipment-optimizer';
import { paidToolChallengeHash } from '../../paid-tools/src/quote-binding';
import { projectNativePaidTool } from './native-paid-tool-presentation';

const stale=()=>new DomainError('EVIDENCE_STALE',409,'Refresh the equipment quote before continuing.');
const unconfirmed=()=>new DomainError('DURABLE_SERVICE_UNAVAILABLE',503,'Recover the original payment approval before trying again.');
type Discovery=z.infer<typeof PaidToolRootDiscoverySchema>;
/** Server-owned enrolled account selectors; they never come from model output
 * or the browser. This gateway cannot sign or submit a transaction. */
export type NativePaidQuoteConfiguration={sourceKey:string;feeKey:string};
export class NativePaidQuoteService{
  constructor(private readonly roots:Pick<PostgresPaidToolRootRepository,'discover'|'quote'>,
    private readonly human:Pick<PostgresPaidToolHumanRepository,'review'|'approve'|'recover'>,
    private readonly configuration:NativePaidQuoteConfiguration,private readonly now=()=>new Date().toISOString()){}
  private scope(session:Session,siteId:string,write=false){
    const actor=session.actor;
    if(actor.environment!=='development'||actor.principalKind!=='human'||!actor.siteIds.includes(siteId)||!session.sites.some(x=>x.id===siteId)||
      write&&(!actor.actionSiteIds.includes(siteId)||!actor.roles.some(r=>r==='owner'||r==='operations')))
      throw new DomainError('FORBIDDEN',403,'Current workspace access is required for this quote.');
    return {environment:'development' as const,organizationId:actor.organizationId,siteId};
  }
  private async state(session:Session,root:string,site:string){
    this.scope(session,site);const value=PaidToolRootDiscoverySchema.parse(await this.roots.discover(session.actor,root,site));
    if(value.rootTaskId!==root||value.policy.rootTaskId!==root||value.policy.instructionRevision!==value.instructionRevision)throw stale();return value;
  }
  private async quote(session:Session,root:string,site:string,state:Discovery){
    const a=state.attachment,p=state.policy,now=Date.parse(this.now());
    if(!a||!p.enabled||!state.evidenceAvailable||a.status!=='waiting'||a.operationId||Date.parse(a.dataValidUntil)<=now)throw stale();
    const raw=PaidToolRootQuoteSchema.parse(await this.roots.quote(session.actor,root,site,a.quoteId));const q=raw.quote,c=q.challenge;
    const {hash:challengeHash,...challengeBody}=c;
    if(raw.rootTaskId!==root||raw.quoteId!==a.quoteId||raw.instructionRevision!==state.instructionRevision||q.providerId!=='equipment_optimizer_v1'||c.providerId!==q.providerId||
      c.payee.environment!=='development'||c.payee.network!=='solana-devnet'||c.payee.mint!==FINANCE_DEVNET_ASSET.mint||c.payee.tokenProgram!==FINANCE_DEVNET_ASSET.tokenProgram||
      challengeHash!==await paidToolChallengeHash(challengeBody)||q.request.hash!==await equipmentRequestHash(raw.requestBody)||q.resource.hash!==await equipmentResourceHash(raw.resourceBody)||
      c.requestHash!==q.request.hash||c.resourceHash!==q.resource.hash||BigInt(c.amountBaseUnits)<=0n||BigInt(c.amountBaseUnits)>BigInt(p.maximumComputationBaseUnits))throw stale();
    const reviewBy=new Date(Math.min(Date.parse(c.expiresAt),Date.parse(a.dataValidUntil))).toISOString();
    if(Date.parse(reviewBy)<=Date.parse(this.now()))throw stale();
    return NativePaidQuoteViewSchema.parse({scope:this.scope(session,site),rootTaskId:root,quoteId:raw.quoteId,instructionRevision:raw.instructionRevision,
      quoteHash:c.hash,expiresAt:c.expiresAt,reviewBy,title:'Equipment package optimizer',reason:raw.reason,assumptions:raw.assumptions,request:raw.requestBody,
      catalogue:{provenance:raw.resourceBody.provenance,currency:'USD',offers:raw.resourceBody.offers},
      amount:{baseUnits:c.amountBaseUnits,decimals:6,symbol:'devnet USDC'},allowanceLimit:{baseUnits:p.maximumComputationBaseUnits,decimals:6,symbol:'devnet USDC'},
      feeCeiling:{baseUnits:p.maximumFeeLamports,decimals:9,symbol:'test SOL'},network:'Solana devnet',asset:{mint:FINANCE_DEVNET_ASSET.mint,tokenProgram:FINANCE_DEVNET_ASSET.tokenProgram,genesis:FINANCE_DEVNET_ASSET.genesis},
      recipient:{label:'Pactwoven demo computation service',owner:c.payee.recipient},
      notice:'This pays for a computation using test tokens. Catalogue prices are sample USD estimates. No equipment is ordered.'});
  }
  async discover(session:Session,root:string,site:string){
    const scope=this.scope(session,site),s=await this.state(session,root,site),a=s.attachment;
    const available=s.evidenceAvailable&&(!a||a.status!=='unavailable'&&Date.parse(a.dataValidUntil)>Date.parse(this.now()));
    const quote=available&&a&&!a.operationId ? await this.quote(session,root,site,s) : null;
    return NativePaidQuoteDiscoverySchema.parse({scope,rootTaskId:root,instructionRevision:s.instructionRevision,
      state:!available?'unavailable':a?.status==='ready'?'delivered':a?.operationId?'payment_in_progress':quote?'awaiting_review':s.policy.enabled?'planning':'not_selected',
      operationId:a?.operationId??null,quote});
  }
  async review(session:Session,root:string,site:string,quoteId:string,reviewId:string){
    this.scope(session,site,true);const s=await this.state(session,root,site);if(s.attachment?.quoteId!==quoteId)throw stale();
    const quote=await this.quote(session,root,site,s);
    const r=PaidToolReviewSchema.parse(await this.human.review(session.actor,{id:reviewId,quoteId,...this.configuration,maximumFeeLamports:quote.feeCeiling.baseUnits}));
    const {reviewHash,...body}=r;
    if(r.id!==reviewId||r.rootTaskId!==root||r.siteId!==site||r.organizationId!==session.actor.organizationId||r.instructionRevision!==quote.instructionRevision||r.quoteId!==quoteId||r.quoteHash!==quote.quoteHash||
      r.amountBaseUnits!==quote.amount.baseUnits||r.maximumFeeLamports!==quote.feeCeiling.baseUnits||r.destinationOwner!==quote.recipient.owner||r.sourceOwner!==r.feePayer||
      reviewHash!==await commandDigest(body)||Date.parse(r.expiresAt)>Date.parse(quote.expiresAt))throw stale();
    const confirmBy=new Date(Math.min(Date.parse(r.expiresAt),Date.parse(quote.reviewBy))).toISOString();
    if(Date.parse(confirmBy)<=Date.parse(this.now()))throw stale();
    return NativePaidQuoteReviewSchema.parse({quote,reviewId:r.id,reviewHash:r.reviewHash,confirmBy,
      source:{tokenAccount:r.sourceAccount,owner:r.sourceOwner,feePayer:r.feePayer},recipientTokenAccount:r.destinationAccount});
  }
  async approve(session:Session,root:string,site:string,input:{quoteId:string;reviewId:string;reviewHash:string;commandKey:string}){
    this.scope(session,site,true);
    const r=await this.review(session,root,site,input.quoteId,input.reviewId);if(r.reviewHash!==input.reviewHash)throw stale();
    const parsed=PaidToolHumanSnapshotSchema.safeParse(await this.human.approve(session.actor,input.reviewId,input.commandKey,input.reviewHash));
    if(!parsed.success||parsed.data.review.id!==input.reviewId||parsed.data.review.reviewHash!==input.reviewHash||parsed.data.review.quoteId!==input.quoteId)throw unconfirmed();
    const {currentInstructionRevision,evidenceAvailable,...snapshot}=parsed.data;
    return {scope:this.scope(session,site),rootTaskId:root,approval:{quoteId:snapshot.review.quoteId,quoteHash:snapshot.review.quoteHash,reviewId:snapshot.review.id,reviewHash:snapshot.review.reviewHash},purchase:await projectNativePaidTool(session,root,site,snapshot,this.now(),{currentInstructionRevision,evidenceAvailable})};
  }
  async recover(session:Session,root:string,site:string,input:{reviewId:string;reviewHash:string;commandKey:string}){
    const scope=this.scope(session,site);
    const value=PaidToolHumanRecoverySchema.parse(await this.human.recover(session.actor,root,site,{kind:'approval',...input}));
    if(!value)return {scope,rootTaskId:root,approval:null,purchase:null};
    const {currentInstructionRevision,evidenceAvailable,...snapshot}=value.snapshot;
    if(snapshot.review.id!==input.reviewId||snapshot.review.reviewHash!==input.reviewHash)throw unconfirmed();
    return {scope,rootTaskId:root,approval:{quoteId:snapshot.review.quoteId,quoteHash:snapshot.review.quoteHash,reviewId:snapshot.review.id,reviewHash:snapshot.review.reviewHash},purchase:await projectNativePaidTool(session,root,site,snapshot,this.now(),{currentInstructionRevision,evidenceAvailable})};
  }
}
