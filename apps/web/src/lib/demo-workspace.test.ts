import { describe, expect, it } from 'vitest';
import { demoActivityFixture, demoPaymentFixture } from './demo-workspace.test-fixtures';
import { demoAgentFocus, demoExactAmount, demoPaymentActions, DemoPaymentCardSchema, demoTextPreview, demoWorkspaceAnnouncement } from './demo-workspace';

describe('event-backed workspace presentation',()=>{
  it('moves focus only for real assigned active actors, including records without occurrence times',()=>{
    const activity=demoActivityFixture();
    expect(demoAgentFocus(activity,true,Date.parse(activity.asOf))).toEqual([
      {actorId:activity.agents[0]!.id,label:'Coordinator',target:'plan',actionId:activity.actions[0]!.id},
      {actorId:activity.agents[1]!.id,label:'Research specialist',target:'team',actionId:activity.actions[1]!.id},
    ]);
  });
  it('stops pointers at the exact freshness boundary, when observation stops, and on historical state',()=>{
    const activity=demoActivityFixture(),now=Date.parse(activity.asOf);
    expect(demoAgentFocus(activity,false,now)).toEqual([]);
    expect(demoAgentFocus(activity,true,Date.parse(activity.freshUntil))).toEqual([]);
    expect(demoAgentFocus({...activity,freshness:'historical'},true,now)).toEqual([]);
    expect(demoAgentFocus({...activity,expiresAt:activity.asOf},true,now)).toEqual([]);
  });
  it('does not animate completed, queued, waiting or paused actions',()=>{
    for(const state of ['completed','queued','waiting','paused','cancelled','needs_review'] as const){
      const activity=demoActivityFixture();activity.actions=activity.actions.map(action=>({...action,state}));
      expect(demoAgentFocus(activity,true,Date.parse(activity.asOf))).toEqual([]);
    }
  });
  it('announces substantive changes once and rejects backwards snapshots',()=>{
    const before=demoActivityFixture();
    expect(demoWorkspaceAnnouncement(before,before,true)).toBe('');
    const next={...before,actions:before.actions.map(action=>({...action,state:'completed' as const}))};
    expect(demoWorkspaceAnnouncement(before,next,true)).toContain('Complete');
    expect(demoWorkspaceAnnouncement(next,{...next,asOf:'2026-11-19T16:00:00.000Z'},true)).toBe('');
    expect(demoWorkspaceAnnouncement(before,next,false)).toBe('');
  });
  it('shortens only the visible preview, preserving original source text',()=>{
    const text='A useful explanation. '.repeat(40),copy=text;
    expect(demoTextPreview(text).text.length).toBeLessThanOrEqual(281);
    expect(demoTextPreview(text).shortened).toBe(true);expect(text).toBe(copy);
    expect(demoTextPreview('Short result.')).toEqual({text:'Short result.',shortened:false});
  });
});
describe('payment presentation boundaries',()=>{
  it('preserves exact large amounts and zero-decimal assets without floating point',()=>{
    expect(demoExactAmount({units:'18446744073709551615',decimals:6,symbol:'TEST',assetLabel:'Test token'})).toBe('18,446,744,073,709.551615 TEST');
    expect(demoExactAmount({units:'125',decimals:0,symbol:'TEST',assetLabel:'Test token'})).toBe('125 TEST');
    expect(demoExactAmount({units:'1',decimals:6,symbol:'TEST',assetLabel:'Test token'})).toBe('0.000001 TEST');
  });
  it('rejects success without a transaction reference and any replay action for uncertain payment',()=>{
    const fixture=demoPaymentFixture();
    expect(DemoPaymentCardSchema.safeParse({...fixture,state:'confirmed',availableActions:['check']}).success).toBe(false);
    expect(DemoPaymentCardSchema.safeParse({...fixture,state:'unknown',availableActions:['pay']}).success).toBe(false);
    expect(DemoPaymentCardSchema.safeParse({...fixture,state:'needs_approval',availableActions:['approve','approve']}).success).toBe(false);
  });
  it('disables actions when stale, hidden or pending; preserves exactly permitted actions',()=>{
    const payment=demoPaymentFixture(),now=Date.parse(payment.recordedAt);
    expect(demoPaymentActions(payment,true,false,now)).toEqual(['approve','reject']);
    expect(demoPaymentActions(payment,false,false,now)).toEqual([]);
    expect(demoPaymentActions(payment,true,true,now)).toEqual([]);
    expect(demoPaymentActions(payment,true,false,Date.parse(payment.validUntil))).toEqual([]);
  });
  it('keeps reconciliation available after the original quote expires',()=>{
    const original=demoPaymentFixture();
    for(const state of ['submitted','confirmed','unknown','failed'] as const){
      const payment=DemoPaymentCardSchema.parse({...original,state,transactionSignature:'2'.repeat(88),availableActions:['check']});
      expect(demoPaymentActions(payment,true,false,Date.parse(payment.validUntil)+60000)).toEqual(['check']);
    }
    expect(demoPaymentActions({...original,state:'authorized',availableActions:['pay']},true,false,Date.parse(original.validUntil))).toEqual([]);
  });
  it('rejects a hostile explorer reference and unsupported network',()=>{
    const payment=demoPaymentFixture();
    expect(DemoPaymentCardSchema.safeParse({...payment,transactionSignature:'javascript:alert(1)'}).success).toBe(false);
    expect(DemoPaymentCardSchema.safeParse({...payment,network:'Solana mainnet'}).success).toBe(false);
  });
});
