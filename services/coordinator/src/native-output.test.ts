import { describe, expect, it } from 'vitest';
import { NativeTaskArtifactSchema, NativeTaskMessageSchema } from '@pactwoven/contracts';
import { EvidenceDocumentsSchema } from './native-evidence.js';
import { NativePlanSchema, NativePlanningSchema, NativeResearchSchema, NativeSynthesisSchema, renderPlanning, renderResearch, renderSynthesis, displayReferences } from './native-output.js';

const now = '2026-11-18T12:00:00Z';
function maximal(character: string) {
  const text=(size:number)=>character.repeat(size);
  const ids=['a'.repeat(128),'b'.repeat(128),'c'.repeat(128)];
  const plan=NativePlanSchema.parse({title:text(180),objective:text(800),constraints:Array(8).fill(text(400)),researchBrief:text(800),planningBrief:text(800),requiresFreshEvidence:false,question:text(600)});
  const research=NativeResearchSchema.parse({summary:text(800),findings:Array.from({length:6},()=>({text:text(800),kind:'quoted_fact',quotes:ids.slice(0,2).map(documentId=>({documentId,text:text(400)}))})),uncertainties:Array(4).fill(text(400))});
  const planning=NativePlanningSchema.parse({summary:text(800),recommendations:Array.from({length:4},()=>({title:text(180),explanation:text(800),documentIds:ids,conditions:Array(3).fill(text(240))})),unresolved:Array(4).fill(text(400)),escalationReason:text(600)});
  const synthesis=NativeSynthesisSchema.parse({title:text(180),summary:text(800),recommendation:text(5000),documentIds:ids,limitations:Array(4).fill(text(400)),question:text(600)});
  const documents=EvidenceDocumentsSchema.parse(ids.map((id,index)=>({id,title:text(300),text:'x'.repeat(16_000),source:{title:text(300),url:`https://example.test/${index}/${'a'.repeat(2000)}`},origin:'retrieved',observedAt:now})));
  return {plan,research,planning,synthesis,documents};
}
describe('working and public output size budgets',()=>{
  it.each(['x','界'])('keeps valid maximum %s output writable to artifacts, messages and checkpoints',character=>{
    const data=maximal(character);
    const researchText=renderResearch(data.research,data.documents); const planningText=renderPlanning(data.planning);const finalText=renderSynthesis(data.synthesis);
    for(const [kind,text] of [['research',researchText],['comparison',planningText],['report',finalText]] as const){
      expect(NativeTaskArtifactSchema.safeParse({id:kind,kind,title:'Result',text,sources:[],createdAt:now}).success).toBe(true);
    }
    expect(NativeTaskMessageSchema.safeParse({id:'message',role:'assistant',text:finalText,createdAt:now}).success).toBe(true);
    const checkpoint={schemaVersion:2,evidenceRevision:Number.MAX_SAFE_INTEGER,resumedThrough:Number.MAX_SAFE_INTEGER,inputFingerprint:'a'.repeat(64),attempts:{plan:3,evidence:3,research:3,planning:3,escalation:3,synthesis:3},usage:{inputTokens:100000,outputTokens:100000,totalTokens:200000},documentsLoaded:true,escalationComplete:true,...data,
      documents:data.documents.map(document=>({...document,validUntil:'2026-11-18T12:15:00.000Z'}))};
    expect(Buffer.byteLength(JSON.stringify(checkpoint))).toBeLessThan(262_144);
  });
  it('replaces internal source references in prose with readable source numbers',()=>{
    const document={id:'quote-a',title:'North Chair quote',text:'quote-a is printed in this exact source excerpt.',source:null,origin:'user_supplied' as const,observedAt:now};
    expect(displayReferences('Compare quote-a and quote-a2.',[document])).toBe('Compare Source 1 and quote-a2.');
    const result=NativeSynthesisSchema.parse({title:'Recommendation',summary:'Use quote-a.',recommendation:'quote-a fits the supplied limits.',documentIds:['quote-a'],limitations:[],question:null});
    const rendered=renderSynthesis(result,[document]);
    expect(rendered).not.toContain('quote-a');expect(rendered).toContain('Source 1: North Chair quote');
    const research=NativeResearchSchema.parse({summary:'Review quote-a.',findings:[{text:'quote-a has a label.',kind:'quoted_fact',quotes:[{documentId:'quote-a',text:document.text}]}],uncertainties:[]});
    expect(renderResearch(research,[document])).toContain(`“${document.text}”`);
  });
  it('rejects multibyte source data that exceeds the checkpoint allocation',()=>{
    const document={id:'a',title:'Source',text:'界'.repeat(16_000),source:null,origin:'retrieved',observedAt:now};
    expect(EvidenceDocumentsSchema.safeParse([document,{...document,id:'b'},{...document,id:'c'}]).success).toBe(false);
  });
});
