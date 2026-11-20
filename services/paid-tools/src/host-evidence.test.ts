import {createHash} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {createPaidRpcEvidenceSink} from './host-evidence';
function fixture(){const requestPayload=JSON.stringify({jsonrpc:'2.0',id:'id',method:'getGenesisHash'}),payloadHex=Buffer.from('malformed response still retained').toString('hex');return{reference:'evidence',method:'getGenesisHash',requestPayload,requestHash:createHash('sha256').update(requestPayload).digest('hex'),observedAt:'2026-11-19T16:00:00Z',payloadHex,sha256:createHash('sha256').update(Buffer.from(payloadHex,'hex')).digest('hex')};}
describe('operation scoped private raw evidence',()=>{
 it('retains exact raw malformed response before parsing',async()=>{const repo={captureForOperation:vi.fn(async()=>{})},capture=fixture();await createPaidRpcEvidenceSink('operation',repo)(capture);expect(repo.captureForOperation).toHaveBeenCalledExactlyOnceWith('operation',capture);});
 it.each(['requestHash','sha256','method','payloadHex'])('rejects changed %s before storage',async field=>{const repo={captureForOperation:vi.fn(async()=>{})},capture={...fixture(),[field]:field==='method'?'sendTransaction':field==='payloadHex'?'nothex':'f'.repeat(64)};await expect(createPaidRpcEvidenceSink('operation',repo)(capture)).rejects.toThrow();expect(repo.captureForOperation).not.toHaveBeenCalled();});
 it('propagates uncertain persistence without recording or parsing a substitute',async()=>{const repo={captureForOperation:vi.fn(async()=>{throw Error('unknown');})};await expect(createPaidRpcEvidenceSink('operation',repo)(fixture())).rejects.toThrow('unknown');expect(repo.captureForOperation).toHaveBeenCalledOnce();});
 it('rejects over-limit payload before storage',async()=>{const repo={captureForOperation:vi.fn(async()=>{})};await expect(createPaidRpcEvidenceSink('operation',repo)({...fixture(),payloadHex:'00'.repeat(131073)})).rejects.toThrow();expect(repo.captureForOperation).not.toHaveBeenCalled();});
});
