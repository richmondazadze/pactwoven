import {generateKeyPairSync} from 'node:crypto';
import {SignJWT} from 'jose';
import {describe,it,expect,vi} from 'vitest';
import {createVercelWorkloadVerifier} from '../../../packages/service-identity/src/index';
import {createPrivateSignerHandler} from '../../paid-tools/src/private-signer-handler';
const identity={team:'pactwoven',teamId:'team_123',project:'executor',projectId:'prj_123'};
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
async function token(change:Record<string,unknown>={}){const now=Math.floor(Date.now()/1000);return new SignJWT({owner:identity.team,owner_id:identity.teamId,project:identity.project,project_id:identity.projectId,environment:'production',...change}).setProtectedHeader({alg:'RS256',typ:'JWT'}).setIssuedAt(now).setNotBefore(now).setExpirationTime(now+60).setIssuer('https://oidc.vercel.com/'+identity.team).setAudience('https://vercel.com/'+identity.team).setSubject(`owner:${identity.team}:project:${identity.project}:environment:production`).sign(keys.privateKey);}
describe('private signer exact workload JWT boundary',()=>{
 it.each([['exact',{},503,1],['foreign project',{project_id:'prj_other'},401,0],['foreign team',{owner_id:'team_other'},401,0],['preview',{environment:'preview'},401,0]] as const)('%s identity',async(_label,change,status,calls)=>{const signer={prepareAndSign:vi.fn(async()=>{throw Error('Stop at fixture producer');}),recoverRetained:vi.fn()},verify=createVercelWorkloadVerifier(identity,async()=>keys.publicKey),handler=createPrivateSignerHandler({signer,verifyExecutor:verify});const response=await handler(new Request('https://signer.vercel.app/internal/paid-tool-signer',{method:'POST',headers:{authorization:'Bearer '+await token(change),'content-type':'application/json'},body:JSON.stringify({schemaVersion:1,environment:'development',operationId:'operation',action:'prepare'})}));expect(response.status).toBe(status);expect(signer.prepareAndSign).toHaveBeenCalledTimes(calls);});
});
