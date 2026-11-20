import { createHash } from 'node:crypto';
import { z } from 'zod';
import { IdSchema, CustodySignatureSchema, CustodyUuidSchema,
  CustodyPrepareHttpSchema, CustodyChallengeHttpSchema, CustodyConfirmationHttpSchema, CustodyConfirmHttpSchema, CustodyCancelHttpSchema,
  CustodyCommandSchema, CustodyResultSchema, CustodyApiMutationResponseSchema,
  FinancialPolicyHttpMutationResponseSchema, FinancialPolicyPreparationRequestSchema, FinancialPolicyPreparationResponseSchema,
  FINANCIAL_POLICY_HTTP_RESPONSE_MAX_BYTES, FINANCE_DEVNET_ASSET,
  type CustodyCommand, type CustodyResult, type CustodyApiMutationResponse,
  type FinancialPolicyHttpMutationResponse, type FinancialPolicyPreparationRequest, type FinancialPolicyPreparationResponse,
  type FinancialPolicyHttpDocumentView } from '@pactwoven/contracts';
import { DomainError, canonicalJson, commandDigest, snapshotFinancialPolicyHttpRequest, financialPolicyHttpRequestHash,
  financialPolicyTextHash, physicalAssetKey, financialBudgetAccountId, financialBudgetPeriodId, validateFinancialGovernanceBundle,
  custodyCommandHash, custodyRecordHash, custodySpecificationHash, custodyWalletChallengeBytes } from '@pactwoven/domain';
import type { FinancialPolicyWriteRequest, FinancialPolicyWriteKind } from './financial-policy-write-service.js';

// Public consistency checks only. No Clerk, database, repository or authority implementation is imported here.
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const financialPolicyWriteOutcomeUnknown = () => new DomainError('FINANCIAL_POLICY_OUTCOME_UNKNOWN', 503,
  'The result is unconfirmed. Preserve the original key and request hash; use original-result lookup.');
const financialPolicyPreparationUnverified = () => new DomainError('FINANCIAL_POLICY_OUTCOME_UNKNOWN', 503,
  'The financial-policy preparation could not be verified.');
const invalid = () => new DomainError('FINANCIAL_POLICY_INPUT_INVALID', 422, 'Use the exact supported policy write parameters.');
const allowed = (kind: string): kind is FinancialPolicyWriteKind => ['save_document', 'save_draft', 'withdraw_draft', 'propose_governance'].includes(kind);
function checked<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input); if (!parsed.success) throw financialPolicyPreparationUnverified(); return parsed.data;
}
function validateFinancialPolicyWire<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success || new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > FINANCIAL_POLICY_HTTP_RESPONSE_MAX_BYTES)
    throw new DomainError('FINANCIAL_POLICY_OUTCOME_UNKNOWN', 503, 'The financial-policy response could not be verified.');
  return parsed.data;
}
const preparationQuerySchema = z.strictObject({ responsibilityId: IdSchema.nullable(), selection: FinancialPolicyPreparationRequestSchema })
  .refine(v => (v.responsibilityId !== null) === (v.selection.action === 'save_draft' || v.selection.action === 'withdraw_draft' ||
    v.selection.action === 'save_document' && v.selection.purpose === 'financial_mandate'));

export function snapshotFinancialPolicyWriteRequest(input: unknown): FinancialPolicyWriteRequest {
  try { const request = snapshotFinancialPolicyHttpRequest(input); if (!allowed(request.kind)) throw invalid(); return request as FinancialPolicyWriteRequest; }
  catch { throw invalid(); }
}

/** Validate the public wire response against the caller's exact snapshot, without private evidence. */
export async function validateFinancialPolicyWriteResponse(requestInput: unknown, raw: unknown): Promise<FinancialPolicyHttpMutationResponse> {
  const request = snapshotFinancialPolicyWriteRequest(requestInput), response = validateFinancialPolicyWire(FinancialPolicyHttpMutationResponseSchema, raw);
  const receipt = response.receipt, r = receipt.record, previous = request.input.previous;
  if (receipt.kind !== request.kind || receipt.key !== request.key || receipt.responsibilityId !== request.responsibilityId || receipt.target.id !== request.id ||
    r.organizationEpoch !== request.input.organizationEpoch || !equal(r.predecessor, previous) || r.version !== (previous?.version ?? 0) + 1 ||
    request.kind === 'save_document' && (r.kind !== 'document' || r.purpose !== request.input.purpose || r.text !== request.input.text) ||
    request.kind === 'save_draft' && (r.kind !== 'draft' || !equal(r.draft, request.input.draft)) ||
    request.kind === 'propose_governance' && (r.kind !== 'governance' || !equal(r.bundle, request.input.bundle) ||
      !equal(r.expectedControl, request.input.expectedControl) || r.expiresAt !== request.input.expiresAt)) throw financialPolicyWriteOutcomeUnknown();
  const publicRequestHash = await financialPolicyHttpRequestHash({ environment: response.scope.environment,
    organizationId: response.scope.organizationId, actorId: response.scope.actor.actorId }, request);
  if (receipt.publicRequestHash !== publicRequestHash) throw financialPolicyWriteOutcomeUnknown();
  return response;
}

export function snapshotFinancialPolicyPreparationSelection(responsibilityId: unknown, selection: unknown): z.infer<typeof preparationQuerySchema> {
  const parsed = preparationQuerySchema.safeParse({ responsibilityId, selection });
  if (!parsed.success) throw new DomainError('FINANCIAL_POLICY_INPUT_INVALID', 422, 'Use the exact supported policy preparation parameters.'); return parsed.data;
}

/** Public consistency checks are not authentication. The private gateway supplies the evaluated decision. */
export async function validateFinancialPolicyPreparationResponse(responsibilityId: string | null,
  selection: FinancialPolicyPreparationRequest, input: unknown, now: () => number = Date.now): Promise<FinancialPolicyPreparationResponse> {
  const q = snapshotFinancialPolicyPreparationSelection(responsibilityId, selection), v = checked(FinancialPolicyPreparationResponseSchema, input);
  const fresh = () => {
    const at = now();
    if (!Number.isFinite(at) || Date.parse(v.observation.observedAt) > at || Date.parse(v.observation.expiresAt) <= at)
      throw financialPolicyPreparationUnverified();
  };
  fresh();
  if (v.responsibilityId !== q.responsibilityId || !equal(v.selection, q.selection)) throw financialPolicyPreparationUnverified();
  const documents: FinancialPolicyHttpDocumentView[] = [...v.target.historicalDocuments];
  if (v.target.state === 'exact' && v.target.record.record.kind === 'document') documents.push(v.target.record as FinancialPolicyHttpDocumentView);
  const m = v.material;
  if (m.action === 'save_draft' && m.document) documents.push(m.document);
  if (m.action === 'propose_governance') {
    if (m.budgetDocument) documents.push(m.budgetDocument);
    if (m.approvalDocument) documents.push(m.approvalDocument);
    if (m.asset) {
      const a = m.asset;
      if (a.genesis !== FINANCE_DEVNET_ASSET.genesis || a.tokenProgram !== FINANCE_DEVNET_ASSET.tokenProgram ||
        a.mint !== FINANCE_DEVNET_ASSET.mint || a.decimals !== 6 || a.policy !== 'solana-original-devnet-usdc-v1' ||
        a.pin.key !== await physicalAssetKey({ genesis: a.genesis, tokenProgram: a.tokenProgram, mint: a.mint }) ||
        m.budgetAccountId !== await financialBudgetAccountId(v.scope.environment, v.scope.organizationId, a.pin.key))
        throw financialPolicyPreparationUnverified();
      fresh();
      for (const p of m.periods) {
        if (p.id !== await financialBudgetPeriodId(m.budgetAccountId!, p.startsAt, p.endsAt)) throw financialPolicyPreparationUnverified(); fresh();
      }
    }
  }
  for (const d of documents) { if (d.record.contentHash !== await financialPolicyTextHash(d.record.text)) throw financialPolicyPreparationUnverified(); fresh(); }
  const scopes = [];
  if ((m.action === 'save_document' || m.action === 'save_draft') && m.draftScope) scopes.push(m.draftScope);
  if (v.target.state === 'exact' && v.target.record.record.kind === 'draft') scopes.push(v.target.record.record.draft.scope);
  for (const d of scopes) {
    if (d.authorityHash !== await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1',
      record: { ...d.authority, environment: v.scope.environment, organizationId: v.scope.organizationId } })) throw financialPolicyPreparationUnverified(); fresh();
  }
  const bundles = [];
  if (v.target.state === 'exact' && v.target.record.record.kind === 'governance') bundles.push(v.target.record.record.bundle);
  if (m.action === 'propose_governance' && m.acceptedConfiguration) bundles.push(m.acceptedConfiguration.record.bundle);
  for (const bundle of bundles) {
    try { await validateFinancialGovernanceBundle(v.scope.environment, v.scope.organizationId, bundle); }
    catch { throw financialPolicyPreparationUnverified(); }
    fresh();
  }
  fresh(); return v;
}
export type CustodyPublicRequest={kind:'prepare';responsibilityId:string;body:z.infer<typeof CustodyPrepareHttpSchema>}|
 {kind:'challenge';responsibilityId:string;setupId:string;body:z.infer<typeof CustodyChallengeHttpSchema>}|
 {kind:'confirmation';responsibilityId:string;setupId:string;body:z.infer<typeof CustodyConfirmationHttpSchema>}|
 {kind:'confirm';responsibilityId:string;setupId:string;body:z.infer<typeof CustodyConfirmHttpSchema>}|
 {kind:'cancel';responsibilityId:string;setupId:string;body:z.infer<typeof CustodyCancelHttpSchema>};
const unknown=()=>new DomainError('CUSTODY_OUTCOME_UNKNOWN',503,'The original setup result could not be confirmed. Check the same request key.');
const custodyApiSignatureHash=(signature:string)=>createHash('sha256').update(Buffer.from(CustodySignatureSchema.parse(signature),'base64')).digest('hex');

export function custodyPrivateCommand(request:CustodyPublicRequest,proofId?:string):CustodyCommand {
 const common={schemaVersion:1,key:request.body.key,responsibilityId:request.responsibilityId,kind:request.kind};
 if(request.kind==='prepare')return CustodyCommandSchema.parse({...request.body,...common});
 const expected={...common,setupId:request.setupId,expectedSetupVersion:request.body.expectedSetupVersion,expectedSetupHash:request.body.expectedSetupHash};
 switch(request.kind){case 'challenge':return CustodyCommandSchema.parse(expected);
  case 'confirmation':return CustodyCommandSchema.parse({...expected,confirmationKey:request.body.confirmationKey,challengeId:request.body.challengeId,challengeHash:request.body.challengeHash,walletEvidenceId:proofId});
  case 'confirm':return CustodyCommandSchema.parse({...expected,confirmationId:request.body.confirmationId,confirmationNonce:request.body.confirmationNonce,mfaEvidenceId:proofId});
  case 'cancel':return CustodyCommandSchema.parse({...expected,expectedSetupControlGeneration:request.body.expectedSetupControlGeneration});}
}
/** A self-consistent record hash is insufficient: bind all references present in the private command. */
export async function validateCustodyApiOperation(input:unknown,command?:CustodyCommand):Promise<CustodyResult>{
 const parsed=CustodyResultSchema.safeParse(input);if(!parsed.success)throw unknown();const r=parsed.data,b=r.body;
 if(b.organizationId!==r.organizationId||b.actorId!==r.actorId||b.responsibilityId!==r.responsibilityId||b.setupId!==r.setupId||
  r.target.id!==b.id||r.target.version!==b.version||r.target.recordHash!==await custodyRecordHash(b)||
  b.kind!==({prepare:'draft',challenge:'wallet_challenge',confirmation:'confirmation',confirm:'owner_binding',cancel:'cancellation'} as const)[r.kind])throw unknown();
 if(b.kind==='draft'&&(b.prepareOperationId!==r.id||b.version!==(b.predecessor?b.predecessor.version+1:1)))throw unknown();
 if(b.kind==='confirmation'){
  const i=b.intent;
  if(i.organizationId!==r.organizationId||i.responsibilityId!==r.responsibilityId||i.setupId!==r.setupId||i.owner.actorId!==r.actorId||b.walletEvidence.version!==1||
   b.intentHash!==await commandDigest(i)||b.requestHash!==await commandDigest({schemaVersion:1,purpose:'custody_setup_owner_binding',request:{nonce:i.nonce,key:i.key,intent:i}}))throw unknown();
 }
 if(b.kind==='owner_binding'){
  if(canonicalJson(b.confirmOperation)!==canonicalJson({id:r.id,key:r.key,commandHash:r.commandHash})||
   b.specification.organization.id!==r.organizationId||b.specification.responsibility.id!==r.responsibilityId||b.specification.owner.actorId!==r.actorId||
   canonicalJson(b.specificationRef)!==canonicalJson({id:b.specification.id,version:b.specification.version,recordHash:await custodySpecificationHash(b.specification)})||
   b.identityEvidence.version!==1||b.walletEvidence.version!==1||b.mfaEvidence.version!==1)throw unknown();
 }
 if(b.kind==='cancellation'&&b.controlGeneration!==b.previousControlGeneration+1)throw unknown();
 if(!command)return r;
 if(r.kind!==command.kind||r.key!==command.key||r.responsibilityId!==command.responsibilityId||r.commandHash!==await custodyCommandHash(r.organizationId,r.actorId,command)||
  (command.kind!=='prepare'&&r.setupId!==command.setupId))throw unknown();
 if(command.kind==='prepare'){
  if(b.kind!=='draft'||canonicalJson(b.specification)!==canonicalJson(command.reviewedSpecificationRef)||canonicalJson(b.predecessor)!==canonicalJson(command.previousDraft))throw unknown();
 }else if(b.kind==='draft'||b.draft.version!==command.expectedSetupVersion||b.draft.recordHash!==command.expectedSetupHash)throw unknown();
 if(command.kind==='confirmation'&&(b.kind!=='confirmation'||b.walletEvidence.id!==command.walletEvidenceId||b.intent.challenge.id!==command.challengeId||
  b.intent.challenge.recordHash!==command.challengeHash||b.intent.key!==command.confirmationKey))throw unknown();
 if(command.kind==='confirm'&&(b.kind!=='owner_binding'||b.confirmation.id!==command.confirmationId||b.mfaEvidence.id!==command.mfaEvidenceId))throw unknown();
 if(command.kind==='cancel'&&(b.kind!=='cancellation'||b.previousControlGeneration!==command.expectedSetupControlGeneration||b.controlGeneration!==command.expectedSetupControlGeneration+1))throw unknown();
 return r;
}
function publicRequest(kind:CustodyPublicRequest['kind'],responsibilityId:string,setupId:string|undefined,input:unknown):CustodyPublicRequest {
 if(kind==='prepare')return{kind,responsibilityId,body:CustodyPrepareHttpSchema.parse(input)};
 const common={responsibilityId,setupId:CustodyUuidSchema.parse(setupId)};
 switch(kind){case 'challenge':return{...common,kind,body:CustodyChallengeHttpSchema.parse(input)};
  case 'confirmation':return{...common,kind,body:CustodyConfirmationHttpSchema.parse(input)};
  case 'confirm':return{...common,kind,body:CustodyConfirmHttpSchema.parse(input)};
  case 'cancel':return{...common,kind,body:CustodyCancelHttpSchema.parse(input)};}
}
function publicProofMatches(request:CustodyPublicRequest,r:CustodyResult):boolean {
 if(request.kind==='confirmation')return r.body.kind==='confirmation'&&r.body.intent.signatureHash===custodyApiSignatureHash(request.body.walletSignature);
 if(request.kind==='confirm')return r.body.kind==='owner_binding'&&r.body.signatureHash===custodyApiSignatureHash(request.body.walletSignature)&&
  r.body.challenge.id===request.body.challengeId&&r.body.challenge.recordHash===request.body.challengeHash&&r.body.confirmation.id===request.body.confirmationId;
 return true;
}
/** The route must provide its preserved public request, not just a response's own key and hash. */
export async function validateCustodyApiMutationResponse(input:unknown,kind:CustodyPublicRequest['kind'],responsibilityId:string,key:string,setupId:string|undefined,publicInput:unknown):Promise<CustodyApiMutationResponse>{
 const parsed=CustodyApiMutationResponseSchema.safeParse(input);if(!parsed.success)throw unknown();const v=parsed.data;
 let request:CustodyPublicRequest;try{request=publicRequest(kind,responsibilityId,setupId,publicInput);}catch{throw unknown();}
 if(request.body.key!==key)throw unknown();
 const proofId=v.operation.body.kind==='confirmation'?v.operation.body.walletEvidence.id:v.operation.body.kind==='owner_binding'?v.operation.body.mfaEvidence.id:undefined;
 const r=await validateCustodyApiOperation(v.operation,custodyPrivateCommand(request,proofId));
 if(!publicProofMatches(request,r))throw unknown();
 if(kind==='prepare'||kind==='challenge'){
  if(!v.review||v.review.organization.id!==r.organizationId||v.review.responsibility.id!==responsibilityId||v.review.owner.actorId!==r.actorId||(r.body.kind!=='draft'&&r.body.kind!=='wallet_challenge')||canonicalJson(r.body.specification)!==canonicalJson({id:v.review.id,version:v.review.version,recordHash:await custodySpecificationHash(v.review)}))throw unknown();
  if(request.kind==='prepare'&&(v.review.ownerWalletPublicKey!==request.body.ownerWalletPublicKey||canonicalJson(request.body.expectedScope)!==canonicalJson({responsibilityVersion:v.review.responsibility.version,responsibilityHash:v.review.responsibility.hash,siteGeneration:v.review.site.generation,siteRecordHash:v.review.site.recordHash,canonicalGeneration:v.review.authority.snapshot.generation,canonicalHash:v.review.authority.recordHash})))throw unknown();
  if(r.body.kind==='wallet_challenge'&&(canonicalJson(r.body.owner)!==canonicalJson(v.review.owner)||r.body.wallet!==v.review.ownerWalletPublicKey||r.body.organizationRegistrationUuid!==v.review.organization.registrationUuid||r.body.responsibilityRegistrationUuid!==v.review.responsibility.registrationUuid||r.body.setupOperationKey!==v.review.setupOperationKey))throw unknown();
 }else if(v.review!==null)throw unknown();
 if(kind==='challenge'){
  if(r.body.kind!=='wallet_challenge'||!v.message)throw unknown();const bytes=Buffer.from(custodyWalletChallengeBytes(r.body));
  if(v.message.bytes!==bytes.toString('base64')||v.message.messageHash!==custodyMessageHash(bytes))throw unknown();
 }else if(v.message!==null)throw unknown();return v;
}
export function custodyMessageHash(bytes:Uint8Array):string {return cryptoHash(bytes);}
const cryptoHash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
