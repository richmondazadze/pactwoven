import { describe,expect,it } from 'vitest';
import { NativeMemoryNoteCommandSchema,NativeMemoryNoteQuerySchema,NativeMemoryNoteDetailSchema } from './native-memory-http';
const input={kind:'remember',siteId:'site',title:'Chairs',text:'Prefer blue chairs.',purpose:'Office purchasing',reviewBy:'2027-01-01T00:00:00Z'};
describe('human memory HTTP contracts',()=>{
 it('accepts readable intent without storage/provenance machinery',()=>expect(NativeMemoryNoteCommandSchema.parse(input)).toEqual(input));
 it.each(['provenance','verification','sourceId','memoryId','digest','recordedAt'])('rejects caller-owned %s',field=>expect(NativeMemoryNoteCommandSchema.safeParse({...input,[field]:'invented'}).success).toBe(false));
 it('requires the exact action selector for correction/removal',()=>{
  expect(NativeMemoryNoteCommandSchema.safeParse({kind:'remove',siteId:'site',noteId:'note'}).success).toBe(false);
  expect(NativeMemoryNoteCommandSchema.safeParse({kind:'remove',siteId:'site',noteId:'note',expected:'a'.repeat(64)}).success).toBe(true);
 });
 it('bounds text and rejects precision which the storage cannot preserve',()=>{
  expect(NativeMemoryNoteCommandSchema.safeParse({...input,title:'🧶'.repeat(91)}).success).toBe(false);
  expect(NativeMemoryNoteCommandSchema.safeParse({...input,text:' \n '}).success).toBe(false);
  expect(NativeMemoryNoteCommandSchema.safeParse({...input,reviewBy:'2027-01-01T00:00:00.0001Z'}).success).toBe(false);
 });
 it('bounds page size and rejects unspecified filters',()=>{
  expect(NativeMemoryNoteQuerySchema.parse({siteId:'site'})).toEqual({siteId:'site',status:'all',limit:20});
  expect(NativeMemoryNoteQuerySchema.safeParse({siteId:'site',limit:51}).success).toBe(false);
  expect(NativeMemoryNoteQuerySchema.safeParse({siteId:'site',search:'anything'}).success).toBe(false);
 });
 it('does not permit a projection to claim source verification or erasure',()=>{
  const note={id:'note',title:'Removed note',siteName:'Site',suppliedBy:'You',updatedAt:'2026-11-18T00:00:00Z',reviewBy:null,status:'removed',text:null,purpose:null,editToken:null,
    sourceLabel:'Human statement — not independently verified',usageLabel:'For permitted work at this site',removalLabel:'Remove from future work',historyRetained:true};
  expect(NativeMemoryNoteDetailSchema.safeParse(note).success).toBe(true);
  expect(NativeMemoryNoteDetailSchema.safeParse({...note,historyRetained:false}).success).toBe(false);
  expect(NativeMemoryNoteDetailSchema.safeParse({...note,sourceLabel:'Verified fact'}).success).toBe(false);
  expect(NativeMemoryNoteDetailSchema.safeParse({...note,sourceLabel:'Source attribution needs review'}).success).toBe(true);
 });
 it('allows truthful generic attribution for review without presenting it as available',()=>{
  const note={id:'note',title:'Chairs',siteName:'Site',suppliedBy:'Contributor needs review',updatedAt:'2026-11-18T00:00:00Z',reviewBy:'2027-01-01T00:00:00Z',
    status:'needs_review',text:'A current statement.',purpose:'Office purchasing',editToken:'a'.repeat(64),sourceLabel:'Source attribution needs review',
    usageLabel:'For permitted work at this site',removalLabel:'Remove from future work',historyRetained:true};
  expect(NativeMemoryNoteDetailSchema.safeParse(note).success).toBe(true);
  expect(NativeMemoryNoteDetailSchema.safeParse({...note,status:'available'}).success).toBe(false);
 });
});
