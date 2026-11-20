import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EquipmentDemoCeilingSchema, sameEquipmentDemoCeiling } from '../lib/equipment-demo-selection';
import { EquipmentDemoCeilingReview, EquipmentDemoOptIn } from './equipment-demo-opt-in';
const ceiling = { maximumComputationBaseUnits: '10000', maximumFeeLamports: '15000', authorization: 'separate_quote_required' as const };
describe('equipment demo planning selection', () => {
  it('is unselected by default and cannot authorize or invoke payment', () => {
    const onSelectionChange = vi.fn(), html = renderToStaticMarkup(createElement(EquipmentDemoOptIn,{ ceiling, selection: null, onSelectionChange }));
    expect(html).not.toContain('checked=""'); expect(html).toContain('does not authorize spending'); expect(html).toContain('0.01 devnet USDC'); expect(html).toContain('0.000015 test SOL'); expect(onSelectionChange).not.toHaveBeenCalled(); expect(html).not.toContain('<button');
  });
  it('requires a new selection when either proposed limit changes', () => {
    expect(sameEquipmentDemoCeiling(ceiling,ceiling)).toBe(true);
    for (const changed of [{ ...ceiling, maximumComputationBaseUnits: '20000' },{ ...ceiling, maximumFeeLamports: '16000' }]) {
      expect(sameEquipmentDemoCeiling(ceiling,changed)).toBe(false); const html = renderToStaticMarkup(createElement(EquipmentDemoOptIn,{ ceiling: changed, selection: ceiling, onSelectionChange: () => {} })); expect(html).not.toContain('checked=""'); expect(html).toContain('proposed limits changed');
    }
  });
  it('keeps the review read-only with separate quote authority and currencies', () => {
    const html = renderToStaticMarkup(createElement(EquipmentDemoCeilingReview,{ selection: ceiling })); expect(html).toContain('Planning permission'); expect(html).toContain('separate, exact quote review'); expect(html).toContain('sample USD estimates'); expect(html).toContain('No equipment is ordered'); expect(html).not.toContain('<button'); expect(html).not.toContain('<input');
  });
  it('rejects invalid limits and any claim that initial selection can authorize spending', () => {
    expect(EquipmentDemoCeilingSchema.safeParse({ ...ceiling, authorization: 'spend_permitted' }).success).toBe(false);
    for (const amount of ['0','-1','0.01','1e6']) expect(EquipmentDemoCeilingSchema.safeParse({ ...ceiling, maximumComputationBaseUnits: amount }).success).toBe(false);
  });
});
