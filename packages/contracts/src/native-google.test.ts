import {describe,it,expect}from'vitest';
import {GOOGLE_READ_SCOPES,NativeGoogleConnectionSchema,NativeGoogleEnvelopeSchema,NativeGoogleTokensSchema}from'./native-google';
const envelope={schemaVersion:1,algorithm:'A256GCM',keyId:'key',nonce:'A'.repeat(16),ciphertext:'B'.repeat(80),tag:'C'.repeat(22)};
const connection={binding:{environment:'simulation',organizationId:'org',actorId:'actor',connectionId:'connection',connectionVersion:1,credentialVersion:1},accountSubject:'subject',accountEmail:'account@example.test',clientId:'client',scopes:[...GOOGLE_READ_SCOPES],status:'connected',tokens:envelope};
describe('private Google strict records',()=>{
 it('rejects plaintext or unknown fields in encrypted credentials',()=>{expect(NativeGoogleEnvelopeSchema.safeParse({...envelope,accessToken:'plaintext'}).success).toBe(false);expect(NativeGoogleConnectionSchema.safeParse({...connection,tokens:{accessToken:'plaintext',refreshToken:'plaintext'}}).success).toBe(false);});
 it('refuses broader scopes, duplicates and unsupported envelope versions',()=>{for(const scopes of [[...GOOGLE_READ_SCOPES,'write'],['openid','email','email']])expect(NativeGoogleConnectionSchema.safeParse({...connection,scopes}).success).toBe(false);expect(NativeGoogleEnvelopeSchema.safeParse({...envelope,schemaVersion:2}).success).toBe(false);});
 it('requires both tokens and version-bound ciphertext',()=>{expect(NativeGoogleTokensSchema.safeParse({accessToken:'a',expiresAt:new Date().toISOString()}).success).toBe(false);expect(NativeGoogleConnectionSchema.safeParse({...connection,binding:{...connection.binding,credentialVersion:0}}).success).toBe(false);});
});
