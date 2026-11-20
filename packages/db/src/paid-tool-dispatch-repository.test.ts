import {describe,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {PostgresPaidToolDispatchRepository,PostgresPaidToolEvidenceRepository} from './paid-tool-dispatch-repository';
import {PaidToolDispatchTargetSchema,PaidToolDispatchFinishSchema} from '../../contracts/src/paid-tool-dispatch';
const target={operationId:'operation',generation:2},token='00000000-0000-4000-8000-000000000001',selector={...target,leaseToken:token};
const mock=(response:unknown)=>{const query=vi.fn().mockResolvedValue({rows:[{response}]});return{query,repo:new PostgresPaidToolDispatchRepository({query} as never),evidence:new PostgresPaidToolEvidenceRepository({query} as never)};};
describe('paid dispatch bounded private adapter',()=>{
 it('returns exact target and opaque dispatch lease',async()=>{const m=mock([{target,dispatchToken:token,delaySeconds:0}]);expect(await m.repo.dispatchClaim({limit:1,leaseMs:30000})).toEqual([{target,dispatchToken:token,delaySeconds:0}]);});
 it('rejects duplicate operation in dispatcher batch',async()=>{const m=mock([{target,dispatchToken:token,delaySeconds:0},{target:{...target,generation:3},dispatchToken:token,delaySeconds:0}]);await expect(m.repo.dispatchClaim({limit:2,leaseMs:1000})).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});});
 it('rejects response exceeding requested batch',async()=>{await expect(mock([{target,dispatchToken:token,delaySeconds:0},{target:{...target,operationId:'other'},dispatchToken:token,delaySeconds:0}]).repo.dispatchClaim({limit:1,leaseMs:1000})).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});});
 it.each([{...selector,operationId:'other'},{...selector,generation:3},{...selector,wireBase64:'forbidden'}])('rejects misbound or overbroad lease',async value=>{await expect(mock(value).repo.claim(target,{leaseMs:90000})).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});});
 it('accepts stale duplicate claim as no lease',async()=>{expect(await mock(null).repo.claim(target,{leaseMs:90000})).toBeNull();});
 it('retains explicit server rejection of stale finish',async()=>{expect(await mock(false).repo.finish(selector,{disposition:'parked',nextWakeAfterMs:null})).toBe(false);});
 it('validates recovery bound',async()=>{await expect(mock(101).repo.recover({limit:100})).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});});
 it.each([0,-1,1.1,Number.MAX_SAFE_INTEGER+1])('rejects invalid generation %s',generation=>{expect(PaidToolDispatchTargetSchema.safeParse({...target,generation}).success).toBe(false);});
 it('caller cannot supply payment status or unbounded delay',()=>{expect(PaidToolDispatchFinishSchema.safeParse({disposition:'complete',nextWakeAfterMs:60001,status:'completed'}).success).toBe(false);});
 it('redacts backend errors',async()=>{const m=mock(null);m.query.mockRejectedValue({code:'XX000',message:'secret-provider-url'});await expect(m.repo.recover({limit:1})).rejects.toMatchObject({message:'The paid operation handoff could not be confirmed.'});});
 it('maps denied service without exposing SQL',async()=>{const m=mock(null);m.query.mockRejectedValue({code:'PT001',message:'secret'});await expect(m.repo.recover({limit:1})).rejects.toMatchObject({code:'FORBIDDEN'});});
});
const sha=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
const request=JSON.stringify({method:'getGenesisHash'}),bytes=Buffer.from('not-json');const capture={reference:'capture',method:'getGenesisHash' as const,requestPayload:request,requestHash:sha(request),observedAt:'2026-11-19T00:00:00.000Z',payloadHex:bytes.toString('hex'),sha256:sha(bytes)};
describe('private operation evidence',()=>{
 it('retains malformed response bytes before parsing',async()=>{const result={operationId:'operation',reference:'capture',sha256:capture.sha256},m=mock(result);expect(await m.evidence.captureForOperation('operation',capture)).toEqual(result);expect(m.query.mock.calls[0]?.[1]?.[1]).toEqual(capture);});
 it.each([{...capture,requestHash:'a'.repeat(64)},{...capture,sha256:'a'.repeat(64)},{...capture,method:'getTransaction' as const}])('rejects mismatched original digest or method',async value=>{const m=mock(null);expect(()=>m.evidence.captureForOperation('operation',value)).toThrow();expect(m.query).not.toHaveBeenCalled();});
 it('accepts full bounded128KiB raw response beyond ordinary100k adapter cap',async()=>{const large=Buffer.alloc(131072,0xff),input={...capture,payloadHex:large.toString('hex'),sha256:sha(large)};expect(await mock({operationId:'operation',reference:'capture',sha256:input.sha256}).evidence.captureForOperation('operation',input)).toHaveProperty('reference','capture');});
 it('rejects cross-operation receipt',async()=>{await expect(mock({operationId:'other',reference:'capture',sha256:capture.sha256}).evidence.captureForOperation('operation',capture)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});});
 it('validates exact signer observation echo',async()=>{const ob={id:'ob',accountKey:'source',slot:'1',amountBaseUnits:'10',observedAt:capture.observedAt,evidenceRef:'capture',evidenceHash:capture.sha256};expect(await mock(ob).evidence.observeForOperation('operation',ob)).toEqual(ob);await expect(mock({...ob,accountKey:'other'}).evidence.observeForOperation('operation',ob)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});});
});
