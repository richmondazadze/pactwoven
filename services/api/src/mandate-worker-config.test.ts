import { describe, expect, it } from 'vitest';
import { readMandateWorkerConfig } from './mandate-worker-config.js';
import { readWorkerConfig, WorkerConfigurationError, type WorkerBindings } from './worker-config.js';

function bindings(): WorkerBindings {
  const url = new URL('postgresql://hyperdrive.local:5432/pactwoven_dev'); url.username = 'pactwoven_mandate'; url.password = 'fixture';
  return { APP_ENVIRONMENT: 'development', WORKER_ROLE: 'mandate', ALLOWED_ORIGINS: 'http://127.0.0.1:3001',
    CLERK_SECRET_KEY: ['sk','test','fixture'].join('_'), CLERK_ISSUER: 'https://worker-fixture.clerk.accounts.dev',
    CLERK_PUBLISHABLE_KEY: `pk_test_${btoa('worker-fixture.clerk.accounts.dev$').replace(/=+$/,'')}`,
    EXPECTED_MANDATE_DATABASE_USER: 'pactwoven_mandate', MANDATE_DATABASE: { connectionString: url.href, host: url.hostname, port: 5432, user: url.username, database: 'pactwoven_dev' } };
}
describe('isolated development mandate Worker configuration',()=>{
  it('accepts only development identity with the exact dedicated Hyperdrive binding',()=>{
    expect(readMandateWorkerConfig(bindings())).toMatchObject({environment:'development',allowedOrigins:['http://127.0.0.1:3001']});
    for(const changed of [{APP_ENVIRONMENT:'production'},{WORKER_ROLE:'api'},{CLERK_SECRET_KEY:['sk','live','fixture'].join('_')},
      {CLERK_ISSUER:'https://other.clerk.accounts.dev'},{EXPECTED_MANDATE_DATABASE_USER:'other_user'},
      {ALLOWED_ORIGINS:'https://example.com/path'},{ALLOWED_ORIGINS:'*'}, {ALLOWED_ORIGINS:'https://example.com,https://example.com'}]){
      expect(()=>readMandateWorkerConfig({...bindings(),...changed})).toThrow(WorkerConfigurationError);
    }
  });
  it('rejects any legacy database/service credential and raw DSN, even empty values',()=>{
    for(const changed of [{DATABASE:bindings().MANDATE_DATABASE!},{ACCESS_DATABASE:bindings().MANDATE_DATABASE!},
      {EXPECTED_DATABASE_USER:'runtime'},{EXPECTED_ACCESS_DATABASE_USER:'access'},
      {IDENTITY_PROVISIONER:{fetch:async()=>new Response()}},{MANDATE_AUTHORITY:{fetch:async()=>new Response()}},
      ...['DATABASE_URL','PROVISIONER_DATABASE_URL','ACCESS_DATABASE_URL','MANDATE_DATABASE_URL'].map(name=>({[name]:''}))]){
      expect(()=>readMandateWorkerConfig({...bindings(),...changed})).toThrow(WorkerConfigurationError);
    }
  });
  it('rejects binding metadata/connection substitution and sensitive details in error messages',()=>{
    const original=bindings(),database=original.MANDATE_DATABASE!;
    for(const changed of [{database:'other'},{host:'other'},{port:5433},{user:'runtime'},
      {connectionString:database.connectionString+'?user=owner'}, {connectionString:database.connectionString+'?sslmode=disable&sslmode=disable'}]){
      let failure:unknown;try{readMandateWorkerConfig({...original,MANDATE_DATABASE:{...database,...changed}});}catch(error){failure=error;}
      expect(failure).toBeInstanceOf(WorkerConfigurationError);expect(String(failure)).not.toMatch(/fixture|postgresql|owner/);
    }
  });
  it('prevents public/provisioner configs from silently accepting mandate database capability',()=>{
    for(const role of ['api','provisioner'] as const){
      const original=bindings(),database=original.MANDATE_DATABASE!;
      const legacy:WorkerBindings={APP_ENVIRONMENT:'development',WORKER_ROLE:role,ALLOWED_ORIGINS:original.ALLOWED_ORIGINS!,
        CLERK_ISSUER:original.CLERK_ISSUER!,CLERK_PUBLISHABLE_KEY:original.CLERK_PUBLISHABLE_KEY!,
        EXPECTED_DATABASE_USER:database.user,DATABASE:database};
      if(role==='api')legacy.IDENTITY_PROVISIONER={fetch:async()=>new Response()};
      else{
        const access=new URL(database.connectionString);access.username='separate_access';
        legacy.CLERK_SECRET_KEY=original.CLERK_SECRET_KEY!;legacy.EXPECTED_ACCESS_DATABASE_USER=access.username;
        legacy.ACCESS_DATABASE={...database,user:access.username,connectionString:access.href};
      }
      expect(()=>readWorkerConfig(legacy,role as 'api')).not.toThrow();
      for(const changed of [{MANDATE_DATABASE:database},{EXPECTED_MANDATE_DATABASE_USER:database.user},{MANDATE_DATABASE_URL:''}]){
        expect(()=>readWorkerConfig({...legacy,...changed},role as 'api')).toThrow(WorkerConfigurationError);
      }
      const binding={fetch:async()=>new Response()};
      if(role==='api')expect(()=>readWorkerConfig({...legacy,MANDATE_AUTHORITY:binding},'api')).not.toThrow();
      else expect(()=>readWorkerConfig({...legacy,MANDATE_AUTHORITY:binding},'provisioner')).toThrow(WorkerConfigurationError);
    }
  });
});
