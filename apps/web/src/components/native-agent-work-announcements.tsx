'use client';
import { useEffect, useRef, useState } from 'react';
import type { NativeAgentWork } from '../../../../packages/contracts/src/native-agent-work';
import { agentWorkMaterialAnnouncement } from '../lib/native-agent-work-presentation';

export function NativeAgentWorkAnnouncements({ work, observing, evidenceExpired = false }: {
  work: NativeAgentWork; observing: boolean; evidenceExpired?: boolean;
}) {
  const previous = useRef<{ work: NativeAgentWork; expired: boolean } | undefined>(undefined);
  const [announcement, setAnnouncement] = useState({ text: '', sequence: 0 });
  useEffect(() => {
    if (!observing) return;
    const before = previous.current;
    const text = agentWorkMaterialAnnouncement(before?.work, work, before?.expired, evidenceExpired);
    if (!before || work.controlVersion >= before.work.controlVersion && Date.parse(work.updatedAt) >= Date.parse(before.work.updatedAt))
      previous.current = { work, expired: evidenceExpired };
    if (text) setAnnouncement(value => ({ text, sequence: value.sequence + 1 }));
  }, [work, observing, evidenceExpired]);
  return <p className="sr-only" role="status" aria-live="polite" aria-atomic="true"><span key={announcement.sequence}>{announcement.text}</span></p>;
}
