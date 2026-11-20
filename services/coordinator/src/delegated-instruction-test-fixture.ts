import {commandDigest} from '../../../packages/contracts/src/canonical';
export async function runtimeFixture(){
const at = Date.now(), instant = (delta = 0) => new Date(at + delta).toISOString();
const identity = (serviceId: string) => ({serviceId,serviceVersion:1,workloadIdentityId:serviceId});
const services = {coordinator:identity('coordinator'),research:identity('research'),planning:identity('planning'),escalation:identity('escalation')};
const target = {organizationId:'fixture_org',taskId:'fixture_root',generation:3};
const selector = {...target,handoffId:null,leaseToken:'384ba9ad-daa1-4797-8586-d71e0f11221a'};
const grant = {schemaVersion:1,id:'fixture_grant',version:1,revocationEpoch:0,mode:'advise',externalEffects:'forbidden',
  scope:{environment:'simulation',organizationId:target.organizationId,issuer:{actorId:'fixture_actor',providerIssuer:'https://fixture.clerk.accounts.dev',subject:'fixture_subject',externalOrganizationId:'fixture_org',externalMembershipId:'fixture_member',membershipVersion:1},organizationEpoch:0,policyVersion:1,purpose:'Compare supplied chairs',sites:[{siteId:'fixture_site',siteVersion:1}],capabilityVersion:1,capabilities:['research_public_sources','read_scoped_memory','draft_advice'],limits:{maxDepth:3,maxChildren:12,maxConcurrentChildren:3,maxAttempts:4,taskTimeoutMs:300000}},
  issuedAt:instant(-60000),expiresAt:instant(600000),issuance:{requestKey:'fixture_request_key',sessionId:'fixture_session',authenticatedAt:instant(-60000),confirmedAt:instant(-60000),scopeDigest:'a'.repeat(64),continuesAfterSignOut:true},revocation:null};
const authority = {kind:'delegated',grantId:grant.id,grantVersion:1,revocationEpoch:0,grantDigest:await commandDigest(grant)};
const assignment = {schemaVersion:1,stepId:'chairs',title:'Review source',brief:'Compare original source material.',role:'research',memoryReferences:[]};
const plan = {objective:'Compare chair options',steps:[{title:assignment.title,brief:assignment.brief,role:'research'}],limitations:[],question:null};
const prompt = 'Compare chairs from https://example.com/chairs';
const state = {schemaVersion:1,inputDigest:await commandDigest({title:'Chair review',prompt,memoryReferences:[]}),plan,slots:[{taskId:'fixture_child',handoffId:'fixture_handoff',requestKey:'fixture_handoff_key',assignment}],usage:{inputTokens:3,outputTokens:2,totalTokens:5},bounded:false,attempt:1};
const child = {taskId:'fixture_child',handoffId:'fixture_handoff',generation:1,assignmentVersion:1,state:'settled',publicationDigest:'b'.repeat(64),outcome:'advice_ready',assignment};
const baseWork = {title:'Chair review',prompt,siteId:'fixture_site',grant,checkpointVersion:2,checkpoint:{stage:'reviewing',summary:plan.objective,steps:[{id:'chairs',title:assignment.title,state:'done'}]},plannerState:JSON.stringify(state),historical:false,children:[child],inputReceipts:[],memoryReferences:[]};
const evidence = {id:'source_1',title:'Chair source',text:'Current source says 125 units.',kind:'public_source',url:'https://example.com/chairs',observedAt:instant(-1000),validUntil:instant(60000)};
const advice = {title:'Chair review',summary:'Review the current source.',findings:[{kind:'source_statement',text:'The page lists stock.',citations:[{id:'source_1',quote:evidence.text}]}],recommendations:['Check suitability.'],limitations:['Advice only.'],question:null};
const body = {schemaVersion:1,kind:'delegated_advice_v1',advisoryOnly:true,domainCompletion:false,stepId:assignment.stepId,role:'research',advice,evidence:[evidence],deployment:'gpt-6.1-terra',usage:{inputTokens:3,outputTokens:2,totalTokens:5}};
const reference = {environment:'simulation',organizationId:target.organizationId,siteId:'fixture_site',artifactId:'fixture_artifact',revision:1,digest:await commandDigest(body)};

return {at,instant,services,target,selector,grant,authority,assignment,plan,prompt,state,child,baseWork,evidence,advice,body,reference};
}
