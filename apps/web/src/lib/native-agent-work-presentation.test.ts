import { describe, expect, it } from 'vitest';
import { agentWorkFixture } from './native-agent-work.test-fixtures';
import { agentWorkMaterialAnnouncement, agentWorkStatusDescription, completedWorkEvidenceCopy } from './native-agent-work-presentation';

describe('team work material announcements', () => {
  it('ignores polling timestamps and never announces internal identifiers', () => {
    const work = agentWorkFixture();
    expect(agentWorkMaterialAnnouncement(work, { ...work, updatedAt: new Date(Date.parse(work.updatedAt) + 1000).toISOString() })).toBe('');
    expect(agentWorkMaterialAnnouncement(undefined, work)).toBe(work.statusText);
  });
  it('announces an actual step transition while aggregate status remains unchanged', () => {
    const work = agentWorkFixture(), next = { ...work, progress: { ...work.progress!, steps: work.progress!.steps.map(step => ({ ...step, state: 'done' as const })) } };
    expect(agentWorkMaterialAnnouncement(work, next)).toBe('Review the supplied sources: complete.');
    expect(agentWorkMaterialAnnouncement(next, next)).toBe('');
  });
  it('announces recorded plan, result and needs-review changes', () => {
    const work = agentWorkFixture();
    expect(agentWorkMaterialAnnouncement({ ...work, progress: null }, work)).toContain('The team recorded a plan with 1 step.');
    const next = { ...work, state: 'completed' as const, statusText: 'Advice is ready', result: { title: 'Chair comparison', summary: 'Actual advice', artifacts: [], advisoryOnly: true as const, evidenceValidUntil: null } };
    expect(agentWorkMaterialAnnouncement(work, next)).toBe('Advice is ready Saved advice: Chair comparison.');
    expect(agentWorkMaterialAnnouncement(work, { ...next, state: 'needs_review', statusText: 'This work needs review', result: { ...next.result, title: 'Work needs review' } })).toContain('Review needed: Work needs review.');
  });
  it('withholds expired evidence and does not announce paused or historical steps as live', () => {
    const work = agentWorkFixture();
    expect(agentWorkMaterialAnnouncement(work, { ...work, evidenceUnavailable: true })).toBe('Earlier evidence needs review. Previous progress and advice are unavailable.');
    expect(agentWorkMaterialAnnouncement(work, work, false, true)).toContain('Earlier evidence needs review');
    expect(agentWorkMaterialAnnouncement({ ...work, progress: null }, { ...work, state: 'paused', statusText: 'Paused' })).toBe('Paused');
    expect(agentWorkMaterialAnnouncement({ ...work, progress: null }, { ...work, progress: { ...work.progress!, historical: true } })).toBe('');
  });
  it('ignores an older response after a newer control and bounds long step announcements', () => {
    const work = agentWorkFixture();
    expect(agentWorkMaterialAnnouncement({ ...work, controlVersion: 5 }, work)).toBe('');
    const next = { ...work, progress: { ...work.progress!, steps: Array.from({ length: 10 }, (_, i) => ({ id: `private_${i}`, title: `Activity ${i + 1}`, state: 'done' as const })) } };
    const message = agentWorkMaterialAnnouncement(work, next);
    expect(message).toContain('7 more steps updated'); expect(message).not.toContain('private_'); expect(message).not.toContain('Activity 4');
  });
});

it('completed unavailable live evidence does not deny independently saved results',()=>{
 const completed={...agentWorkFixture(),state:'completed' as const,statusText:'Earlier evidence is no longer available.',evidenceUnavailable:true};
 expect(agentWorkStatusDescription(completed)).toBe(completedWorkEvidenceCopy.status);expect(agentWorkMaterialAnnouncement(undefined,completed)).toContain(completedWorkEvidenceCopy.body);expect(agentWorkMaterialAnnouncement(undefined,completed)).not.toContain(completed.statusText);
 expect(agentWorkStatusDescription({...completed,evidenceUnavailable:false})).toBe(completed.statusText);expect(agentWorkStatusDescription({...completed,evidenceUnavailable:false},true)).toBe(completedWorkEvidenceCopy.status);
 for(const state of ['working','waiting','paused','cancelled','needs_review'] as const)expect(agentWorkStatusDescription({...completed,state})).toBe(completed.statusText);
});
