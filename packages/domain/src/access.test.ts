import {describe,expect,it} from 'vitest';
import {validateAccessScope} from './access.js';
describe('baseline access grants',()=>{
 it('does not turn read-only or unrelated read-site access into action rights',()=>{
  const now='2026-11-14T12:00:00.000Z';
  expect(()=>validateAccessScope({roles:['auditor'],siteIds:['site_a'],actionSiteIds:['site_a'],expiresAt:null},now)).toThrowError(expect.objectContaining({code:'FORBIDDEN'}));
  expect(()=>validateAccessScope({roles:['operations'],siteIds:['site_a'],actionSiteIds:['site_b'],expiresAt:null},now)).toThrow();
  expect(validateAccessScope({roles:['finance'],siteIds:[],actionSiteIds:['site_a'],expiresAt:null},now).actionSiteIds).toEqual(['site_a']);
  expect(()=>validateAccessScope({roles:['finance'],siteIds:[],actionSiteIds:[],expiresAt:now},now)).toThrow();
 });
});
