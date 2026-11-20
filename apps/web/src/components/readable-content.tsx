'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { demoTextPreview } from '../lib/demo-workspace';
import { Icon } from './icon';

/** Bounds supporting records on desktop without removing any of their contents. */
export function ReadingRegion({ label, children }: { label: string; children: ReactNode }) {
  const id = useId(), viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null), collapsing = useRef(false);
  const [expanded, setExpanded] = useState(false), [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const element = viewport.current, inner = content.current;
    if (!element || !inner) return;
    // Keep the same toggle mounted while expanding and collapsing so keyboard
    // focus does not fall back to the document between resize observations.
    const measure = () => { if (!expanded) setOverflow(element.scrollHeight > element.clientHeight + 2); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element); observer.observe(inner);
    return () => observer.disconnect();
  }, [expanded]);
  useLayoutEffect(() => {
    if (!collapsing.current) return;
    collapsing.current = false;
    toggle.current?.focus({ preventScroll: true });
    toggle.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [expanded]);
  return <div className="reading-region" data-expanded={expanded || undefined}>
    <div id={id} ref={viewport} className="reading-region-viewport" role={overflow && !expanded ? 'region' : undefined}
      aria-label={overflow && !expanded ? label : undefined} tabIndex={overflow && !expanded ? 0 : undefined}>
      <div ref={content} className="reading-region-content">{children}</div>
    </div>
    {(overflow || expanded) && <div className="reading-region-footer"><span>{expanded ? 'Showing the full record' : 'Scroll to read more, or expand'}</span>
      <button ref={toggle} type="button" aria-controls={id} aria-expanded={expanded} onClick={() => { collapsing.current = expanded; setExpanded(value => !value); }}>
        {expanded ? 'Use compact view' : 'Show all'}<Icon name="chevron-down" className={expanded ? 'rotated' : ''} size={16}/>
      </button>
    </div>}
  </div>;
}

export function WorkReadingToolbar({ title, headingId, status, children }: { title: string; headingId: string; status: ReactNode; children?: ReactNode }) {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const element = document.getElementById(headingId)?.closest('header');
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) setStuck(!entry.isIntersecting && entry.boundingClientRect.top < 56);
    }, { rootMargin: '-56px 0px 0px 0px', threshold: 0 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [headingId]);
  return <div className="work-reading-toolbar" data-stuck={stuck || undefined}>
      <div className="work-reading-title"><button type="button" title={title} aria-label="Back to task heading" onClick={() => {
        const heading = document.getElementById(headingId);
        heading?.focus({ preventScroll: true }); heading?.scrollIntoView({ block: 'start', behavior: 'instant' });
      }}><Icon name="arrow-left" size={16}/><span>{title}</span></button>{status}</div>
      {children}
    </div>;
}

/** Only informational prose is previewed. Never use for consent, warnings or amounts. */
export function ReadableText({ text, label = 'Read full text' }: { text: string; label?: string }) {
  const preview = demoTextPreview(text, 420);
  if (!preview.shortened) return <p className="readable-text">{text}</p>;
  return <div className="readable-copy"><p className="readable-text">{preview.text}</p>
    <details className="readable-disclosure"><summary>{label}<Icon name="chevron-down" size={16}/></summary>
      <ReadingRegion label={label}><p className="readable-text">{text}</p></ReadingRegion>
    </details>
  </div>;
}
