// Layout adapted from Efferd Integrations 4 (retrieved 2026-11-18).
// Source: https://efferd.com/r/radix-nova/integrations-4.json
// Efferd license: https://efferd.com/license — end-product use; no standalone redistribution.
import { Icon, type IconName } from '../icon';
import { SectionHeading, TextLink } from './primitives';

type ToolTile = { row: number; col: number; icon?: IconName; brand?: boolean };

const tiles: ToolTile[] = [
  { row: 0, col: 1 },
  { row: 0, col: 3, icon: 'clipboard' },
  { row: 1, col: 0 },
  { row: 1, col: 2, icon: 'search' },
  { row: 1, col: 4, icon: 'calendar' },
  { row: 2, col: 1, icon: 'plug' },
  { row: 2, col: 2, brand: true },
  { row: 2, col: 3, icon: 'folder' },
  { row: 3, col: 0 },
  { row: 3, col: 2, icon: 'receipt' },
  { row: 3, col: 4, icon: 'ledger' },
  { row: 4, col: 1, icon: 'connected-nodes' },
  { row: 4, col: 3 },
];

export function ToolIntegrations() {
  return <section id="tool-layer" className="mk-section mk-container mk-tool-integrations" aria-label="The planned tool layer">
    <div className="mk-tool-integrations-copy">
      <SectionHeading
        eyebrow="Tools & context · in development"
        title="The right tools. The same context."
        description="Research, documents, schedules and records belong with the work they support. We’re building a tool layer that lets agents use them within a shared brief and clear permissions."
      />
      <p className="mk-tool-integrations-note">Each tool observation will stay linked to its source, task and result—so the next agent can pick up with context.</p>
      <TextLink href="/how-it-works">See how the work connects</TextLink>
    </div>
    <figure className="mk-tool-integrations-figure">
      <div className="mk-tool-integrations-grid" role="img" aria-label="Concept: Pactwoven surrounded by tools for research, documents, scheduling and evidence.">
        {tiles.map(({ row, col, icon, brand }) => <div
          key={`${row}_${col}`}
          aria-hidden="true"
          className={`mk-tool-tile${brand ? ' mk-tool-tile-brand' : icon ? ' mk-tool-tile-icon' : ''}`}
          style={{ gridRow: row + 1, gridColumn: col + 1 }}
        >
          {brand ? <img src="/brand/symbol.svg" alt="" width="56" height="56" /> : icon ? <Icon name={icon} size={28} /> : null}
        </div>)}
      </div>
      <figcaption>Illustrative tool layer · in development</figcaption>
    </figure>
  </section>;
}
