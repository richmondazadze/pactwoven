import { expect, it } from 'vitest';
import { mandateBlockerText } from './mandates';
it('describes terminal proposal decisions without implying current authority or a human decision',()=>{
  expect(mandateBlockerText('DECISION_TERMINAL')).toBe('This proposal is no longer open for a decision. Review its recorded outcome.');
});
