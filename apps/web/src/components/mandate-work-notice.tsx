'use client';
import Link from 'next/link';
import { useMandateAuthoringMemory } from './mandate-authoring-memory';
export function MandateWorkNotice() {
  const memory = useMandateAuthoringMemory();
  if (!memory.ready || memory.hidden) return null;
  const pending = memory.inventory.manifests.filter(item => item.pending);
  if (!pending.length) return null;
  return <div className="mandate-workspace-notice" role="status"><span>{pending.length === 1 ? 'A mandate preparation has an original result to check.' : `${pending.length} mandate preparations have original results to check.`} Unsaved text is available only while its private review is retained.</span>{pending.map(item => <Link key={item.preparationId} className="text-action" href={`/app/responsibilities/${encodeURIComponent(item.responsibilityId)}/mandates/prepare#mandate-authoring-recovery`}>Open original preparation</Link>)}</div>;
}
