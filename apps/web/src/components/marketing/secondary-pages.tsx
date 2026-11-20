import Link from 'next/link';
import { Icon, type IconName } from '../icon';
import { Disclosure } from '../ui';
import { WorkflowJourney } from './workflow-journey';
import { ToolIntegrations } from './tool-integrations';
import { Availability, Cta, FeatureGrid, PageHero, SectionHeading, TextLink } from './primitives';
import { useCases, type UseCase } from './content';

const specialists: { icon: IconName; title: string; description: string }[] = [
  { icon: 'connected-nodes', title: 'Coordinator', description: 'Keeps the brief, task assignments and unresolved decisions connected.' },
  { icon: 'search', title: 'Research', description: 'Collects relevant information and preserves the sources behind it.' },
  { icon: 'split-route', title: 'Planning', description: 'Builds the sequence, checks dependencies and surfaces missing inputs.' },
  { icon: 'truck', title: 'Supplier', description: 'Works through options and proposed terms within the scope it is given.' },
];

export function PlatformPage() {
  return <>
    <PageHero eyebrow="The platform" title="One place to direct the whole operation." description="Give the work a clear brief. Keep the agents, decisions and evidence connected to it. That is the Pactwoven workspace we’re building.">
      <div className="mk-evidence" aria-label="Illustrative workspace structure">
        <div className="mk-label"><Icon name="layers" /> Workspace concept</div>
        <div className="mk-receipt">
          <p className="mk-kicker">Responsibility</p>
          <h3>Harbor Hall, ready for Friday.</h3>
          <p>Equipment, delivery and a clear definition of done.</p>
          <dl className="mk-metrics"><div><dt>Scope</dt><dd>120 chairs + 20 tables</dd></div><div><dt>Next decision</dt><dd>Review the proposed plan</dd></div><div><dt>Authority</dt><dd>No commitments authorized</dd></div></dl>
        </div>
        <div className="mk-detail-summary"><Icon name="receipt" /><p>Every result belongs with its source and the work it supports.</p></div>
      </div>
    </PageHero>
    <section className="mk-section mk-container">
      <SectionHeading title="The context stays with the work." description="The operator should not have to keep reassembling the brief across conversations and tools." />
      <FeatureGrid items={[
        { icon: 'clipboard', title: 'A shared brief', description: 'The outcome, requirements, timing and acceptance criteria give the work a stable starting point.' },
        { icon: 'connected-nodes', title: 'Connected agents', description: 'The native runtime is being built so specialists can hand off tasks and evidence without making you the messenger.' },
        { icon: 'receipt', title: 'An inspectable record', description: 'Keep proposals, decisions and supporting evidence attached to the responsibility they concern.' },
      ]} />
    </section>
    <section className="mk-dark"><div className="mk-section mk-container mk-split">
      <SectionHeading eyebrow="Native agents · in development" title="Specialists working from the same brief." description="One human directs the work. Each agent has a focused job, shared context and an explicit boundary. These are software agents, not extra human accounts." />
      <div className="mk-rule-list">{specialists.map(item => <article className="mk-rule" key={item.title}><Icon name={item.icon} /><div><h3>{item.title}</h3><p>{item.description}</p></div></article>)}</div>
    </div></section>
    <ToolIntegrations />
    <section className="mk-section mk-container mk-split">
      <SectionHeading title="See the step. Inspect the reason." description="The intended execution view brings the current task, agent handoffs and selected tool activity together. A visible result should always lead back to evidence." />
      <div className="mk-reading"><p>Watching work happen is useful when it helps you make a decision. Pactwoven’s live agent view will be driven by actual execution events, with clear states for waiting, interruption and failure.</p><p>Browser observations will appear when a real browser tool is involved. A completed animation will never stand in for a completed operation.</p><TextLink href="/how-it-works">Follow an example</TextLink></div>
    </section>
    <Availability />
    <Cta title="Start with a clear responsibility." description="Explore the development workspace while we build the connected agent experience." />
  </>;
}

export function HowItWorksPage() {
  return <>
    <PageHero eyebrow="How it works" title="A clear request. A connected path to done." description="Pactwoven is being built to take an outcome through a visible sequence of planning, action and evidence—with one human directing the work." />
    <WorkflowJourney />
    <section className="mk-tint"><div className="mk-section mk-container">
      <SectionHeading title="The unexpected belongs in the flow." description="Autonomy is only useful if you can understand what happens when the original plan stops fitting." />
      <FeatureGrid items={[
        { icon: 'circle-question', title: 'Missing information', description: 'Ask for the detail that changes the decision. Keep the rest of the work and its context intact.' },
        { icon: 'pause-circle', title: 'An action needs authority', description: 'Pause the dependent step and make the decision visible. A suggestion is not permission to execute.' },
        { icon: 'return-arrow', title: 'An outcome is uncertain', description: 'Preserve the operation’s reference and investigate. Do not repeat a consequential action just because a response was lost.' },
      ]} />
    </div></section>
    <section className="mk-section mk-container mk-split">
      <SectionHeading title="A few useful distinctions." description="Clear states make the operator’s decisions easier." />
      <div className="mk-reading"><Disclosure title="Does a prompt authorize every action in a plan?"><p>No. A prompt describes an outcome. Consequential actions still need the applicable scope, permissions and authority. The native execution system is being built around those boundaries.</p></Disclosure><Disclosure title="Will the agents work while I’m away?"><p>Durable background execution and recovery are part of the native runtime in development. The current marketing demonstration is illustrative and does not run tasks in the background.</p></Disclosure><Disclosure title="Can I use the workspace now?"><p>Yes. The development workspace supports responsibility and policy-record workflows. Complete autonomous supplier execution and payments are still being built and qualified.</p></Disclosure></div>
    </section>
    <Cta title="Give the work a clear starting point." />
  </>;
}

export function UseCasesPage() {
  return <>
    <PageHero eyebrow="Use cases" title="Start with the work you need to move." description="Some jobs stretch across suppliers, schedules and financial decisions. Pactwoven brings those pieces back to one responsibility." />
    <section className="mk-section mk-container">
      <div className="mk-case-grid">{useCases.map(item => <Link className="mk-case-card" key={item.slug} href={`/use-cases/${item.slug}`}><Icon name={item.icon} size={28} /><h2>{item.title}</h2><p>{item.description}</p><span>Explore the workflow <Icon name="arrow-right" size={18} /></span></Link>)}</div>
    </section>
    <section className="mk-tint"><div className="mk-section mk-container mk-split">
      <SectionHeading title="Different work. The same foundation." description="A useful agent needs more than an instruction. It needs the context that makes an outcome clear." />
      <ol className="mk-process-list"><li><Icon name="clipboard" /><div><h3>The outcome</h3><p>What needs to be true when the work is complete.</p></div></li><li><Icon name="key" /><div><h3>The boundaries</h3><p>What is allowed, what is limited and what needs review.</p></div></li><li><Icon name="receipt" /><div><h3>The evidence</h3><p>The observations and records that support the result.</p></div></li></ol>
    </div></section>
    <Availability />
    <Cta title="Begin with the responsibility." description="Create the scope and acceptance criteria in the development workspace." />
  </>;
}

export function UseCaseDetailPage({ item }: { item: UseCase }) {
  return <>
    <div className="mk-container mk-back"><TextLink href="/use-cases">All use cases</TextLink></div>
    <PageHero eyebrow={item.title} title={item.heading} description={item.description}>
      <div className="mk-detail-summary"><Icon name={item.icon} size={32} /><p className="mk-label">An example brief</p><blockquote>{item.prompt}</blockquote><p className="mk-label">Illustrative workflow · agent execution in development</p></div>
    </PageHero>
    <section className="mk-section mk-container mk-split">
      <SectionHeading title="Keep the details from becoming the job." />
      <div className="mk-reading"><p>{item.problem}</p></div>
    </section>
    <section className="mk-tint"><div className="mk-section mk-container mk-split">
      <SectionHeading title="From the brief to a better decision." description="This is the intended connected workflow. The availability section below separates the current preview from the automation still being built." />
      <ol className="mk-steps">{item.steps.map((step, i) => <li className="mk-step" key={step.title}><span className="mk-step-number" aria-hidden="true">{i + 1}</span><div><h3>{step.title}</h3><p>{step.description}</p></div></li>)}</ol>
    </div></section>
    <section className="mk-section mk-container">
      <div className="mk-quote"><Icon name="receipt" size={32} /><h2>The result we’re building toward.</h2><p>{item.result}</p></div>
      <div className="mk-status-grid"><article className="mk-status-card"><span className="mk-status">Available in the development preview</span><h3>A clear foundation</h3><ul>{item.available.map(text => <li key={text}>{text}</li>)}</ul></article><article className="mk-status-card"><span className="mk-status">In development</span><h3>The connected agent workflow</h3><ul>{item.planned.map(text => <li key={text}>{text}</li>)}</ul></article></div>
      <p className="mk-label">The development preview is not approved for live supplier orders or payments.</p>
    </section>
    <section className="mk-section mk-container">
      <SectionHeading title="Explore another workflow." />
      <div className="mk-case-grid">{useCases.filter(other => other.slug !== item.slug).map(other => <Link className="mk-case-card" href={`/use-cases/${other.slug}`} key={other.slug}><Icon name={other.icon} size={24} /><h3>{other.title}</h3><p>{other.description}</p><span>Explore the workflow <Icon name="arrow-right" size={18} /></span></Link>)}</div>
    </section>
    <Cta title="Give this work one clear home." />
  </>;
}

export function TrustPage() {
  const controls = [
    { icon: 'key' as const, title: 'Access follows the work', description: 'The development workspace checks sign-in and organization access. Record access depends on the applicable permissions and scope.' },
    { icon: 'shield-lock' as const, title: 'Credentials stay behind the service', description: 'Provider secrets belong in server-side configuration. The planned agent runtime will use scoped tools rather than exposing reusable credentials to the browser.' },
    { icon: 'wallet' as const, title: 'A policy is not a payment', description: 'Creating a financial-policy record does not move funds. The complete financial execution lifecycle remains in development.' },
    { icon: 'document-signature' as const, title: 'Decisions concern a specific version', description: 'Recorded policy documents retain their version and identity so a later review can refer to the same material.' },
    { icon: 'pause-circle' as const, title: 'Authority can change', description: 'The native execution model is being built to stop new unauthorized actions while preserving the work and obligations already created.' },
    { icon: 'receipt' as const, title: 'Results need evidence', description: 'The planned runtime will connect actions to their observations and receipts. Unknown outcomes must stay visible until reconciled.' },
  ];
  return <>
    <PageHero eyebrow="Trust & control" title="Autonomy needs boundaries." description="You should be able to understand what an agent is allowed to do, what it actually did and which decision still belongs to you.">
      <div className="mk-evidence"><div className="mk-label"><Icon name="shield-lock" /> The control model</div><div className="mk-receipt"><h3>A proposal is not authority.</h3><p>The work moves through explicit boundaries.</p><ol className="mk-process-list"><li><Icon name="clipboard" /><span>Define the scope</span></li><li><Icon name="key" /><span>Check current authority</span></li><li><Icon name="connected-nodes" /><span>Execute within the boundary</span></li><li><Icon name="receipt" /><span>Keep the evidence</span></li></ol></div><p className="mk-label">Native agent execution is in development.</p></div>
    </PageHero>
    <section className="mk-section mk-container">
      <SectionHeading title="Controls with a clear purpose." description="Some foundations are available in the development workspace. The full autonomous lifecycle still needs implementation and verification." />
      <FeatureGrid items={controls} />
    </section>
    <section className="mk-dark"><div className="mk-section mk-container mk-split">
      <SectionHeading title="Keep the important states distinct." description="Confidence comes from a record you can inspect, including the parts that are unresolved." />
      <div className="mk-rule-list"><article className="mk-rule"><Icon name="clipboard" /><div><h3>Proposed and accepted</h3><p>An agent’s recommendation does not silently become an agreement.</p></div></article><article className="mk-rule"><Icon name="wallet" /><div><h3>Expected and settled</h3><p>A planned payment, an obligation and received funds need separate records.</p></div></article><article className="mk-rule"><Icon name="circle-question" /><div><h3>Pending and unknown</h3><p>A lost response is a reason to investigate the existing operation, not to assume success or retry blindly.</p></div></article></div>
    </div></section>
    <section id="preview-status" className="mk-section mk-container mk-split">
      <SectionHeading title="Where we are today." description="Pactwoven is a development product. This page describes its current foundations and intended control model, not a certification or a guarantee of complete security." />
      <div className="mk-reading"><p>The workspace supports responsibility and financial-policy record workflows. Native agents, complete supplier execution, and end-to-end payment and reconciliation flows are still being built and qualified.</p><p>Do not use the preview for live supplier orders or production payments. We will expand availability alongside evidence that the complete workflow and its controls work together.</p><TextLink href="/platform">Explore the platform</TextLink></div>
    </section>
    <Cta title="Start with clarity about the limits." description="Explore the development workspace and its current record workflows." />
  </>;
}

export function AboutPage() {
  return <>
    <PageHero eyebrow="About Pactwoven" title="Built for the work between the tools." description="A company’s work does not fit inside one conversation. It crosses tasks, suppliers, decisions and systems. We’re building a place to keep that work connected.">
      <div className="mk-detail-summary"><img src="/brand/symbol.svg" alt="Pactwoven Joined Fold symbol" width="144" height="144" /><p className="mk-quote">Keep the promise.<br />Coordinate the rest.</p></div>
    </PageHero>
    <section className="mk-section mk-container mk-split">
      <SectionHeading title="The operator should not have to be the messenger." />
      <div className="mk-reading"><p>Today, using several AI tools can create another coordination job: move the brief into one tool, carry the findings to another, reconstruct what happened and decide what to trust.</p><p>Pactwoven’s direction is one human working with a native coordinator and focused specialist agents. They should share the right context, hand off tasks and leave behind a clear record.</p><p>The goal is practical: less chasing the pieces, more understanding of the whole. The operator stays close to the decisions that matter without manually relaying every step.</p></div>
    </section>
    <section className="mk-tint"><div className="mk-section mk-container">
      <SectionHeading title="What guides the product." />
      <FeatureGrid items={[
        { icon: 'user-cog', title: 'One human, clear control', description: 'Internal agents are software specialists. They should not create another layer of human roles to manage.' },
        { icon: 'connected-nodes', title: 'Our own connected system', description: 'We are building Pactwoven’s coordination, memory and execution experience around existing model APIs.' },
        { icon: 'receipt', title: 'Useful work leaves evidence', description: 'An answer should lead to its sources. An action should lead to its record. Uncertainty should be easy to find.' },
      ]} />
    </div></section>
    <Availability />
    <section className="mk-section mk-container"><div className="mk-quote"><h2>Make the work easier to direct.<br />Make the outcome easier to trust.</h2><p>That is the standard we are building Pactwoven toward.</p><TextLink href="/how-it-works">See the intended experience</TextLink></div></section>
    <Cta title="Give the work a place to come together." />
  </>;
}
