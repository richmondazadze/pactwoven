import type { NativeAgentWork } from '../../../../packages/contracts/src/native-agent-work';

const stepLabels = { planned: 'planned', active: 'in progress', done: 'complete', blocked: 'needs review' } as const;
const unavailable = (work: NativeAgentWork, expired: boolean) => work.evidenceUnavailable || expired;

/** Announce recorded changes only. Poll timestamps and identical snapshots are silent. */
export function agentWorkMaterialAnnouncement(previous: NativeAgentWork | undefined, next: NativeAgentWork,
  previousExpired = false, expired = false): string {
  if (previous && (previous.id !== next.id || next.controlVersion < previous.controlVersion ||
    Date.parse(next.updatedAt) < Date.parse(previous.updatedAt))) return '';
  const hidden = unavailable(next, expired), wasHidden = previous ? unavailable(previous, previousExpired) : false;
  if (!previous) return `${next.statusText}${hidden ? '. Earlier evidence needs review.' : ''}`;
  const changes: string[] = [];
  if (previous.state !== next.state || previous.statusText !== next.statusText) changes.push(next.statusText);
  if (hidden && !wasHidden) changes.push('Earlier evidence needs review. Previous progress and advice are unavailable.');
  if (!hidden) {
    const resultChanged = next.result && (!previous.result || wasHidden ||
      JSON.stringify(next.result) !== JSON.stringify(previous.result));
    if (resultChanged) changes.push(`${next.state === 'needs_review' ? 'Review needed' : 'Saved advice'}: ${next.result!.title}.`);
    if (next.progress && !next.progress.historical && !['paused', 'cancelled', 'waiting_external'].includes(next.state)) {
      const oldSteps = new Map((wasHidden ? [] : previous.progress?.steps ?? []).map(step => [step.id, step]));
      const changed = next.progress.steps.filter(step => !oldSteps.has(step.id) || oldSteps.get(step.id)!.state !== step.state || oldSteps.get(step.id)!.title !== step.title);
      if ((!previous.progress || wasHidden) && next.progress.steps.length) changes.push(`The team recorded a plan with ${next.progress.steps.length} ${next.progress.steps.length === 1 ? 'step' : 'steps'}.`);
      changes.push(...changed.slice(0, 3).map(step => `${step.title}: ${stepLabels[step.state]}.`));
      if (changed.length > 3) changes.push(`${changed.length - 3} more steps updated. Review recorded progress for details.`);
    }
  }
  return changes.join(' ');
}
