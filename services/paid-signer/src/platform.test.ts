import {readFile} from 'node:fs/promises';
import {describe,it,expect} from 'vitest';
import {paidSignerPath} from '../../paid-tools/src/private-signer-protocol';
describe('private signer platform boundary',()=>{it('routes only the exact private handler path',async()=>{const v=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));expect(v.rewrites).toEqual([{source:paidSignerPath,destination:'/api/index'}]);expect(v.functions['api/index.mjs'].maxDuration).toBeGreaterThan(45);});});
