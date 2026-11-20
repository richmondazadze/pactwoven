import{describe,it,expect}from'vitest';import{googleOAuthConfiguration,GOOGLE_CALLBACK_PATH,NativeGoogleGateway}from'./native-google-service';
const configured={publicWebOrigin:'https://pactwoven.example.test',clientId:'client.apps.googleusercontent.com',clientSecret:'synthetic-private-client-secret',expectedEmail:'richverseecotech@gmail.com'};
describe('Google OAuth configuration boundary',()=>{
 it('constructs one exact callback from the approved HTTPS origin',()=>{const config=googleOAuthConfiguration(configured);expect(config.redirectUri).toBe(configured.publicWebOrigin+GOOGLE_CALLBACK_PATH);expect(Object.isFrozen(config)).toBe(true);});
 it.each(['http://pactwoven.example.test','https://pactwoven.example.test/','https://user@pactwoven.example.test','https://pactwoven.example.test/other','https://pactwoven.example.test?redirect=elsewhere'])('rejects noncanonical origin %s',publicWebOrigin=>{expect(()=>googleOAuthConfiguration({...configured,publicWebOrigin})).toThrow();});
 it.each([undefined,{}, {...configured,clientSecret:''},{...configured,clientId:'wrong'},{...configured,expectedEmail:'other@example.test'}])('missing or mismatched configuration fails unavailable',input=>{expect(()=>googleOAuthConfiguration(input)).toThrow();});
});
describe('Google gateway configuration binding',()=>{
 const binding=Object.freeze({clientId:configured.clientId,redirectUri:configured.publicWebOrigin+GOOGLE_CALLBACK_PATH,expectedEmail:configured.expectedEmail});
 const authorizationUrl='https://accounts.google.com/o/oauth2/v2/auth?'+new URLSearchParams({client_id:binding.clientId,redirect_uri:binding.redirectUri});
 const gateway=(b=binding,url=authorizationUrl)=>new NativeGoogleGateway(configured.publicWebOrigin,{}as never,{binding:b,begin:async()=>({authorizationUrl:url}),callback:async()=>({connectionId:'unused'}),recover:async()=>({}),revoke:async()=>{}},{}as never,{}as never,{}as never);
 it('rejects a connection callback on a different origin before beginning',()=>expect(()=>gateway(Object.freeze({...binding,redirectUri:'https://other.example.test'+GOOGLE_CALLBACK_PATH}))).toThrow());
 it('rejects a mutable connection configuration',()=>expect(()=>gateway({...binding})).toThrow());
 it('returns the correctly bound authorization URL',async()=>expect(await gateway().begin('unused',new AbortController().signal)).toEqual({authorizationUrl}));
 it.each(['redirect','client','duplicate'])('rejects a returned %s substitution',async kind=>{const u=new URL(authorizationUrl);if(kind==='redirect')u.searchParams.set('redirect_uri','https://other.example.test/callback');if(kind==='client')u.searchParams.set('client_id','other.apps.googleusercontent.com');if(kind==='duplicate')u.searchParams.append('client_id',binding.clientId);await expect(gateway(binding,u.href).begin('unused',new AbortController().signal)).rejects.toMatchObject({code:'GOOGLE_INTEGRATION_REQUIRED'});});
});
