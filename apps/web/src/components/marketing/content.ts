import type { IconName } from '../icon';

export type UseCase = {
  slug: string;
  title: string;
  description: string;
  icon: IconName;
  heading: string;
  problem: string;
  prompt: string;
  steps: { title: string; description: string }[];
  result: string;
  available: string[];
  planned: string[];
};

export const useCases: UseCase[] = [
  {
    slug: 'event-operations',
    title: 'Event operations',
    description: 'Bring equipment, delivery windows and the final handoff into one plan.',
    icon: 'building',
    heading: 'Ready before the doors open.',
    problem: 'An event depends on more than a booking. Quantities, delivery access, timing and acceptance all need to agree. When those details live in different conversations, the operator becomes the person holding the entire plan together.',
    prompt: 'Prepare Harbor Hall for Friday. We need 120 chairs and 20 tables delivered before 10 am. Bring me a plan before making any commitments.',
    steps: [
      { title: 'Make the outcome explicit', description: 'Capture the site, quantities, arrival window and what counts as a complete handoff.' },
      { title: 'Build a connected plan', description: 'The planned agent workflow will research options and connect equipment availability with delivery dependencies.' },
      { title: 'Review before committing', description: 'Bring the proposed terms, missing information and required authority back to the operator.' },
      { title: 'Follow the handoff', description: 'The intended execution flow will connect delivery evidence to acceptance, with unresolved items kept visible.' },
    ],
    result: 'A shared definition of ready, with each dependency and decision attached to the same responsibility.',
    available: ['Create a responsibility with a site and service window.', 'Record quantities, requirements and acceptance criteria.', 'Review the responsibility in your organization workspace.'],
    planned: ['Agent-led supplier research and comparison.', 'Authorized supplier coordination and delivery follow-up.', 'End-to-end evidence capture and acceptance reconciliation.'],
  },
  {
    slug: 'supplier-coordination',
    title: 'Supplier coordination',
    description: 'Keep requirements, proposed terms and changes attached to the work.',
    icon: 'truck',
    heading: 'Keep every handoff connected.',
    problem: 'A supplier handoff can change in several places at once: a quantity, an arrival window, a price or a condition. A useful system must keep the latest proposal distinct from what was actually agreed, so an old message never becomes an accidental commitment.',
    prompt: 'Compare suppliers for the Harbor Hall equipment. Check the quantities and delivery window, flag unclear terms, and return a recommendation for review.',
    steps: [
      { title: 'Start from the same requirements', description: 'Give every comparison the same scope, service window and acceptance criteria.' },
      { title: 'Compare with context', description: 'The planned supplier agent will collect options, preserve their sources and surface conditions that do not match the brief.' },
      { title: 'Keep changes explicit', description: 'Show changed terms as a new proposal. A recommendation alone must not reserve capacity or accept an offer.' },
      { title: 'Record the next commitment', description: 'The intended exchange will link an authorized handoff to the version, authority and evidence that supported it.' },
    ],
    result: 'A recommendation you can inspect, with the terms, open questions and next decision in the same place.',
    available: ['Define the work suppliers would need to fulfill.', 'Keep requirements within a scoped organization workspace.', 'Record the intended outcome and acceptance policy.'],
    planned: ['Native supplier agents and verified supplier exchange.', 'Offer comparison, capacity checks and authorized commitments.', 'Changed-term recovery and delivery evidence across suppliers.'],
  },
  {
    slug: 'financial-oversight',
    title: 'Financial oversight',
    description: 'Connect spending policy, proposed commitments and the records behind them.',
    icon: 'ledger',
    heading: 'Keep the numbers tied to the work.',
    problem: 'An estimated cost, an approved limit and a settled payment are different facts. When they appear as one reassuring number, the operator loses the detail needed to make a sound decision. Pactwoven is being built to keep those states distinct and traceable.',
    prompt: 'Review the financial policy for this responsibility. Show the limits and required approvals, then flag what still needs a decision before any spending.',
    steps: [
      { title: 'Define the financial boundaries', description: 'Start with the responsibility and its applicable policy, including the terms that need review.' },
      { title: 'Inspect the recorded version', description: 'Use the stored policy record to see exactly which text and version a decision concerns.' },
      { title: 'Separate proposal from authority', description: 'The planned agent workflow will explain options while backend controls determine which actions are actually permitted.' },
      { title: 'Reconcile against evidence', description: 'The intended financial lifecycle will track commitments, obligations and settlement separately, including unknown outcomes.' },
    ],
    result: 'A clearer decision with the relevant policy and supporting record, without treating an estimate as money already moved.',
    available: ['Prepare and review financial-policy documents.', 'Save versioned policy records in the development workspace.', 'Recover recorded policy details for later review.'],
    planned: ['Agent-assisted financial analysis within scoped authority.', 'The complete allocation, obligation and reconciliation lifecycle.', 'Qualified end-to-end payment and settlement integrations.'],
  },
];

export function findUseCase(slug: string) {
  return useCases.find(item => item.slug === slug);
}
