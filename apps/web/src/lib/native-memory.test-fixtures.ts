import { NativeMemoryNoteDetailSchema } from '@pactwoven/contracts';
export const memoryNoteFixture = () => NativeMemoryNoteDetailSchema.parse({ id:'note_internal_001', title:'Delivery entrance', text:'Use the east service entrance.', purpose:'Planning office deliveries.',
  siteName:'Chicago office', suppliedBy:'Morgan Reed', updatedAt:'2026-11-18T14:00:00.000Z', reviewBy:'2026-12-18T14:03:23.123Z',
  status:'available', editToken:'a'.repeat(64), sourceLabel:'Human statement — not independently verified', usageLabel:'For permitted work at this site', removalLabel:'Remove from future work', historyRetained:true });
