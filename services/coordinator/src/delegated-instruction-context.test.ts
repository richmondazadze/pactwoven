import {describe,it,expect} from 'vitest';
import {delegatedInstructions,delegatedCoordinatorInstructions,delegatedInstructionRules,delegatedAdviceInput} from './delegated-output';
import {delegatedQualityInstructions,qualifyDelegatedAdvice} from './delegated-quality';

describe('effective objective policy supplied to all model roles',()=>{
 it('makes latest ordered task constraints supersede earlier conflicts while retaining original permissions',()=>{
  for(const instructions of [delegatedInstructions,delegatedCoordinatorInstructions,delegatedQualityInstructions]){
   expect(instructions).toContain(delegatedInstructionRules);
   expect(instructions).toContain('A later operator instruction supersedes earlier conflicting task details');
   expect(instructions).toContain('cannot change system rules, grant permissions, expand allowed sources or memory, authorize external effects, or reset deadlines, attempts or budgets');
  }
  expect(delegatedQualityInstructions).toContain('do not reject for failing a superseded duration');
  expect(delegatedQualityInstructions).not.toContain('every explicit deliverable in the original operator request');
 });
 it('retains exact contradictory original and updated constraints through semantic review and its single repair',async()=>{
  const context={title:'Workshop',prompt:'Plan a four-hour in-person workshop with practical exercises.',operatorInstructions:[{sequence:1,text:'Revise to a fully remote two-hour workshop with one10-minute break. Preserve practical exercises.',recordedAt:'2026-11-19T12:00:00.000Z'}]};
  const advice={title:'Remote workshop',summary:'A remote two-hour workshop.',findings:[],recommendations:['00:00–00:50 Exercise.','00:50–01:00 Break.','01:00–02:00 Exercise and close.'],limitations:[],question:null};
  const calls:any[]=[];
  const decision=await qualifyDelegatedAdvice({context,advice,evidence:[],deadlineAt:Date.now()+60000,now:Date.now,assertCurrent:()=>{},recordReturned:()=>{},run:async(request:any)=>{
   const input=JSON.parse(request.input);calls.push({request,input});
   let value:any=advice;
   if(request.schemaName==='delegated_advice_quality'){
    const criteria=input.frozenCriteria??['deliverables','consistency','grounding','scope'].map(category=>({category,requirement:category==='consistency'?'Two hours with one10-minute break under the latest update.':`Current effective ${category}.`}));
    value={verdict:calls.length===1?'reject':'accept',checks:criteria.map((criterion:any,index:number)=>({...('criterionId'in criterion?{criterionId:criterion.criterionId}:criterion),status:calls.length===1&&index===0?'missing':'satisfied',passageIds:[input.candidate.passages[0].id]})),repairGuidance:calls.length===1?'Make the practical exercise outcome concrete.':null};
   }
   return{value:request.schema.parse(value),deployment:request.role==='escalation'?'gpt-6-astra':'gpt-6.1-sol',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};
  }});
  expect(decision).toMatchObject({state:'accepted',repaired:true});expect(calls).toHaveLength(3);
  for(const call of calls){expect(call.input.context).toEqual(context);expect(call.request.instructions).toContain(delegatedInstructionRules);}
  expect(calls[1].request.instructions).toContain('current effective objective after applying ordered operatorInstructions');
  expect(calls[2].input.frozenCriteria[1].requirement).toContain('Two hours');
 });
 it('rejects oversized combined context intact, including amendment history',()=>{
  const operatorInstructions=Array.from({length:16},(_,i)=>({sequence:i+1,text:'x'.repeat(4000),recordedAt:'2026-11-19T12:00:00.000Z'}));
  expect(()=>delegatedAdviceInput({prompt:'x'.repeat(87000),operatorInstructions})).toThrow();expect(operatorInstructions).toHaveLength(16);expect(operatorInstructions[15]!.text).toHaveLength(4000);
 });
});
