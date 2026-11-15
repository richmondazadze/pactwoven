import {describe,expect,it} from 'vitest';
import {GrantAccessCommandSchema,ReviseAccessCommandSchema,RevokeAccessCommandSchema} from './index';
const scope={roles:['finance'],siteIds:[],actionSiteIds:['site_a'],expiresAt:null};
const command={expectedVersion:0,mandateVersion:null,authorityEpoch:0,payload:{...scope,externalSubject:'user_a',externalMembershipId:'membership_a'}};
describe('member access command boundary',()=>{
 it('requires exact versioned tenant authority and rejects caller proof/actor data',()=>{
  expect(GrantAccessCommandSchema.safeParse(command).success).toBe(true);
  for(const changed of [{...command,authorityEpoch:null},{...command,mandateVersion:1},{...command,expectedVersion:1},
   {...command,actorId:'attacker'},{...command,payload:{...command.payload,evidence:{verifiedAt:'now'}}},
   {...command,payload:{...command.payload,roles:['service']}},{...command,payload:{...command.payload,actionSiteIds:['site_a','site_a']}}]){
   expect(GrantAccessCommandSchema.safeParse(changed).success).toBe(false);
  }
  expect(ReviseAccessCommandSchema.safeParse({...command,expectedVersion:1,payload:scope}).success).toBe(true);
  expect(ReviseAccessCommandSchema.safeParse({...command,expectedVersion:1}).success).toBe(false);
  expect(RevokeAccessCommandSchema.safeParse({...command,expectedVersion:1,payload:{reason:'Remove access'}}).success).toBe(true);
 });
});
