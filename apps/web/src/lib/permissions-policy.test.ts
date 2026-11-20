import {describe,it,expect} from 'vitest';
import config from '../../next.config';
describe('same-origin operator voice permissions',()=>{
 it('emits a same-origin microphone allowance while camera and geolocation stay denied',async()=>{
  const rules=await config.headers!();
  const all=rules.find(rule=>rule.source==='/:path*');
  expect(all).toBeDefined();
  expect(all!.headers.filter(header=>header.key.toLowerCase()==='permissions-policy')).toEqual([{key:'Permissions-Policy',value:'camera=(), microphone=(self), geolocation=()'}]);
 });
});
