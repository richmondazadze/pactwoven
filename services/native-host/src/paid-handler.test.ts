import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
const f=vi.hoisted(()=>({run:vi.fn(),publishRoot:vi.fn(),options:null as any}));
vi.mock('./paid-dispatch',()=>({paidQueueDeploymentId:'dpl_test',paidQueue:{handleCallback:(run:any,options:any)=>{f.options=options;return async()=>run({schemaVersion:1,environment:'development',target:{operationId:'op',generation:1}});}}}));
vi.mock('./paid-runtime',()=>({runPaidQueueMessage:f.run}));
vi.mock('./delegated-host-runtime',()=>({publishDelegatedHostWork:f.publishRoot}));
import {POST} from './handlers/consume-paid';
import {NativeDeliveryRetry} from './consume';
afterEach(()=>vi.unstubAllEnvs());
beforeEach(()=>{vi.stubEnv('VERCEL_DEPLOYMENT_ID','dpl_test');f.run.mockReset().mockResolvedValue('settled');f.publishRoot.mockReset().mockResolvedValue({accepted:1,unconfirmed:0});});
describe('private paid callback continuation',()=>{
 it('publishes original root continuation after durable paid stage',async()=>{await POST(new Request('https://executor.vercel.app/api/consume-paid'));expect(f.run).toHaveBeenCalledOnce();expect(f.publishRoot).toHaveBeenCalledOnce();expect(f.options.visibilityTimeoutSeconds).toBe(300);});
 it('republishes root on stale-generation retry without repeating paid execution',async()=>{f.run.mockResolvedValue('discarded');await POST(new Request('https://executor.vercel.app/api/consume-paid'));expect(f.publishRoot).toHaveBeenCalledOnce();});
 it('retains queue callback retry after original root publication is unconfirmed',async()=>{f.publishRoot.mockResolvedValue({accepted:0,unconfirmed:1});await expect(POST(new Request('https://executor.vercel.app/api/consume-paid'))).rejects.toBeInstanceOf(NativeDeliveryRetry);});
 it('does not swallow paid stage failure',async()=>{f.run.mockRejectedValue(new NativeDeliveryRetry());await expect(POST(new Request('https://executor.vercel.app/api/consume-paid'))).rejects.toBeInstanceOf(NativeDeliveryRetry);expect(f.publishRoot).not.toHaveBeenCalled();expect(f.options.retry(new NativeDeliveryRetry()).afterSeconds).toBeGreaterThan(0);});
});
