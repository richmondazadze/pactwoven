import { describe, expect, it } from 'vitest';
import { DomainError } from '@pactwoven/domain';
import type { ServiceBinding } from './worker-config.js';
import { serviceAccessGateway } from './worker-access.js';
import { serviceMandateGateway } from './worker-mandate.js';
import { serviceIdentityVerifier } from './worker-identity.js';
import { serviceProvisioner } from './worker-provisioner.js';
import { serviceJsonRequest } from './worker-service.js';

const token='synthetic-service-token',authorization=`Bearer ${token}`,key='service_request_key_001';
const issuer='https://service-fixture.clerk.accounts.dev';
const identity={subject:'subject_a',externalOrganizationId:'org_a',externalOrganizationName:'Test',externalMembershipId:'member_a',externalRole:'org:admin',membershipObservedAt:new Date().toISOString(),sessionId:'session_a',authenticatedAt:new Date().toISOString()};
const request=(path:string)=>new Request(`https://api.example${path}`,{method:'POST',headers:{Authorization:authorization,'Idempotency-Key':key}});

describe('unverified service exceptions never become public domain errors',()=>{
  const calls:Record<string,(binding:ServiceBinding)=>Promise<unknown>>={
    identity:binding=>serviceIdentityVerifier(binding,authorization,issuer)(token),
    bootstrap:binding=>serviceProvisioner(binding,authorization).bootstrapOrganization(identity,key,{expectedVersion:0,mandateVersion:null,authorityEpoch:0,payload:{initialSite:{name:'Test site',timeZone:'America/Chicago'}}},'trace'),
    access:binding=>serviceAccessGateway(binding,request('/v1/members/target_a/revoke'),issuer).revoke(token,'target_a',key,{expectedVersion:1,mandateVersion:null,authorityEpoch:1,payload:{reason:'Access ended.'}},'trace'),
    mandate:binding=>serviceMandateGateway(binding,request('/v1/responsibilities/responsibility_a/mandate-proposals/proposal_a/decision'),issuer).decide(token,'responsibility_a','proposal_a',key,{schemaVersion:1,action:'AUTHORIZE',proposal:{id:'proposal_a',version:1,hash:'a'.repeat(64)},expectedDecisionVersion:1,expectedOrganizationEpoch:1,expectedHead:null,reason:null},'trace'),
  };
  it.each(Object.entries(calls))('%s hides known/unknown DomainErrors and private stream failures',async(_name,invoke)=>{
    const failures=[new DomainError('FORBIDDEN',403,'private-backend-diagnostics'),new DomainError('CUSTOM_DATABASE_ERROR',503,'private-backend-diagnostics'),new Error('private-backend-diagnostics')];
    for(const failure of failures){
      for(const fetch of [async()=>{throw failure;},async()=>new Response(new ReadableStream({start(controller){controller.error(failure);}}))]){
        let caught:unknown;
        try{await invoke({fetch});}catch(error){caught=error;}
        expect(caught).toBeInstanceOf(Error);
        expect(caught).not.toBe(failure);
        expect((caught as Error).message).not.toContain('private-backend-diagnostics');
        expect((caught as DomainError).code).not.toBe('FORBIDDEN');
        expect((caught as DomainError).code).not.toBe('CUSTOM_DATABASE_ERROR');
      }
    }
  });
  it('drops unverified exception types at the shared boundary',async()=>{
    const failure=new DomainError('AUTH_REQUIRED',401,'private-backend-diagnostics');
    await expect(serviceJsonRequest({fetch:async()=>{throw failure;}},request('/v1/example'))).rejects.toEqual(new Error('Private service exchange was not confirmed'));
  });
});
