'use client';

import { useEffect, useRef, useState } from 'react';
import { useMotion } from '../motion';
import { ExecutionDemo } from './execution-demo';
import { SectionHeading } from './primitives';

const chapters = [
  { title: 'Describe the outcome', copy: 'Tell Pactwoven what needs to happen, by when, and which boundaries matter. The brief becomes the reference for the work.', step: 0 },
  { title: 'Find the evidence', copy: 'The research agent gathers options and preserves the source behind each one. Missing information stays visible.', step: 1 },
  { title: 'Connect the plan', copy: 'The coordinator connects focused tasks, dependencies and agent findings to the same run.', step: 2 },
  { title: 'Keep the decision yours', copy: 'The proposal is checked against the brief and applicable authority. A suggested action is still a proposal until authorized.', step: 3 },
  { title: 'Inspect the result', copy: 'Bring the recommendation, open questions and evidence back together. The record tells you what happened and what still needs attention.', step: 4 },
];

export function WorkflowJourney() {
  const { mode } = useMotion();
  const root = useRef<HTMLElement>(null);
  const [guided, setGuided] = useState(false);
  const [chapter, setChapter] = useState(0);

  useEffect(() => {
    // Short/touch/reduced-motion views retain the compact, manually controlled example.
    const desktop = matchMedia('(min-width: 1100px) and (min-height: 780px) and (hover: hover) and (pointer: fine)');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const stage = root.current?.querySelector<HTMLElement>('.mk-journey-stage');
    const update = () => {
      // Reserve the guide control before it mounts so enabling it cannot cause an oscillation.
      const guideSpace = stage?.querySelector('.mk-demo-follow') ? 0 : 52;
      const fits = !!stage && stage.getBoundingClientRect().height + guideSpace + 144 <= innerHeight;
      setGuided(mode === 'normal' && desktop.matches && !reduced.matches && fits);
    };
    const resize = new ResizeObserver(update);
    if (stage) resize.observe(stage);
    update(); desktop.addEventListener('change', update); reduced.addEventListener('change', update);
    window.addEventListener('resize', update);
    return () => { resize.disconnect(); desktop.removeEventListener('change', update); reduced.removeEventListener('change', update); window.removeEventListener('resize', update); };
  }, [mode]);

  useEffect(() => {
    const node = root.current;
    if (!guided || !node) return;
    const steps = [...node.querySelectorAll<HTMLElement>('.mk-journey-step')];
    let frame = 0;
    let disposed = false;
    function read() {
      frame = 0;
      if (disposed || document.hidden) return;
      const positions = steps.map(step => step.getBoundingClientRect().top);
      let next = 0;
      positions.forEach((top, index) => { if (top <= innerHeight * .55) next = index; });
      // React updates only when crossing a chapter, never for continuous progress.
      setChapter(previous => previous === next ? previous : next);
    }
    function schedule() { if (!frame && !document.hidden) frame = requestAnimationFrame(read); }
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    document.addEventListener('visibilitychange', schedule);
    const resize = new ResizeObserver(schedule); resize.observe(node);
    schedule();
    return () => {
      disposed = true; cancelAnimationFrame(frame); resize.disconnect();
      window.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [guided]);

  return <section ref={root} className="mk-section mk-container mk-journey" data-guided={guided}>
    <div className="mk-journey-intro"><SectionHeading title="Follow the handoff." description="Explore an illustrative agent run. This demonstration shows the intended experience; it does not contact suppliers or move money." /></div>
    <div className="mk-journey-layout">
      <ol className="mk-steps mk-journey-chapters">{chapters.map((item, index) => <li className="mk-step mk-journey-step" data-current={guided && chapter === index} key={item.title}>
        <span className="mk-step-number" aria-hidden="true">{index + 1}</span>
        <div><h3>{item.title}</h3><p>{item.copy}</p></div>
      </li>)}</ol>
      <div className="mk-journey-stage">
        <p className="mk-journey-hint">{guided ? 'Scroll to follow the example. Explore any step yourself.' : 'Explore each step in the example.'}</p>
        <ExecutionDemo guidedStep={guided ? chapters[chapter]!.step : undefined} />
      </div>
    </div>
  </section>;
}
