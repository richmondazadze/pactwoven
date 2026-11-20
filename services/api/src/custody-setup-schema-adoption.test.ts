import {describe,expect,it,vi} from 'vitest';
import {CustodyReadObservationSchema,type CustodyReadObservation} from '@pactwoven/db';
import {createCustodyApiVerifier,type CustodyApiOwnerScope} from './custody-setup-verifier.js';

const at=Date.parse('2026-11-15T12:00:00.000Z');
const instant=(value:number)=>new Date(value).toISOString();
function fixture(){
 const observation:CustodyReadObservation={identity:{subject:'user_schema',externalOrganizationId:'external_org_schema',
  externalOrganizationName:'Synthetic schema organization',externalMembershipId:'membership_schema',externalRole:'org:admin',
  membershipObservedAt:instant(at-1000),sessionId:'session_schema',authenticatedAt:instant(at-3600000)},
  observation:{issuer:'https://synthetic.invalid',tokenHash:'a'.repeat(64),tokenIssuedAt:instant(at-10000),
   observedAt:instant(at-500),expiresAt:instant(at+60000)}};
 const scope:CustodyApiOwnerScope={environment:'development',organizationId:'org_schema',externalOrganizationId:'external_org_schema',
  responsibilityId:'responsibility_schema',owner:{actorId:'owner_schema',membershipVersion:1,subject:'user_schema',
   externalMembershipId:'membership_schema',sessionId:'session_schema'}};
 const observe=vi.fn(async()=>structuredClone(observation));
 const verifyFactors=vi.fn(async():Promise<never>=>{throw new Error('No factor verification is expected.');});
 const verifier=createCustodyApiVerifier({observe,verifyFactors,now:()=>at});
 return {observation,scope,observe,verifyFactors,verifier};
}

describe('custody private observation schema adoption',()=>{
 it('produces a database-readable observation while retaining the oldest timestamp',async()=>{
  const f=fixture(),observed=await f.verifier.observe('synthetic-observation');
  expect(CustodyReadObservationSchema.parse(observed)).toEqual(observed);
  expect(observed.observation.observedAt).toBe(f.observation.identity.membershipObservedAt);
  expect(observed.identity.authenticatedAt).toBe(f.observation.identity.authenticatedAt);
  expect(()=>f.verifier.assertFresh(observed,f.scope)).not.toThrow();
  expect(f.verifyFactors).not.toHaveBeenCalled();
 });
 it.each(['membershipObservedAt','authenticatedAt'] as const)('requires a canonical %s before returning an observation',async field=>{
  for(const value of ['2026-11-15T11:59:59Z','2026-11-15T11:59:59.000+00:00','2026-02-30T11:59:59.000Z']){
   const f=fixture();f.observation.identity[field]=value;
   await expect(f.verifier.observe('synthetic-observation')).rejects.toThrow();
   expect(f.verifyFactors).not.toHaveBeenCalled();
  }
 });
 it('retains strict observation and owner shapes for injected private values',async()=>{
  const f=fixture();
  f.observe.mockResolvedValueOnce({...f.observation,extra:true} as CustodyReadObservation);
  await expect(f.verifier.observe('synthetic-observation')).rejects.toThrow();
  const observed=await f.verifier.observe('synthetic-observation');
  expect(()=>f.verifier.assertFresh(observed,{...f.scope,extra:true} as CustodyApiOwnerScope)).toThrow();
  expect(f.verifyFactors).not.toHaveBeenCalled();
 });
});
