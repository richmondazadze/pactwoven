'use client';
import Link from 'next/link';
import { useMandateAuthoringMemory } from './mandate-authoring-memory';
import { useMandateAuthorityMemory } from './mandate-authority-memory';
export function MandateWorkNotice() {
  const memory = useMandateAuthoringMemory(), authority = useMandateAuthorityMemory();
  if (memory.hidden || authority.hidden) return null;
  const pending = memory.inventory.manifests.filter(item => item.pending);
  const responsibilities = [...new Set(authority.inventory.locators.map(item => item.responsibilityId))];
  return <>{memory.ready && pending.length > 0 && <div className="mandate-workspace-notice" role="status"><span>{pending.length === 1 ? 'A mandate preparation has an original result to check.' : `${pending.length} mandate preparations have original results to check.`} Unsaved text is available only while its private review is retained.</span>{pending.map(item => <Link key={item.preparationId} className="text-action" href={`/app/responsibilities/${encodeURIComponent(item.responsibilityId)}/mandates/prepare#mandate-authoring-recovery`}>Open original preparation</Link>)}</div>}{authority.ready && authority.inventory.locators.length > 0 && <div className="mandate-workspace-notice" role="status"><span>{authority.inventory.locators.length === 1 ? 'An authority control has an original result to check.' : `${authority.inventory.locators.length} authority controls have original results to check.`} Leaving a page does not cancel them.</span>{responsibilities.map((id, index) => <Link key={id} className="text-action" href={`/app/responsibilities/${encodeURIComponent(id)}/mandates#mandate-authority-recovery`}>Open authority references{responsibilities.length > 1 ? ` ${index + 1}` : ''}</Link>)}</div>}</>;
}
