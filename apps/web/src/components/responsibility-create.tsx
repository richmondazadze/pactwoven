'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { CreateResponsibilityCommandSchema, type Operation } from '@pactwoven/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { RequestError } from '@/lib/api';
import { zonedDateTimeToIso, LocalTimeError } from '@/lib/time';
import { newCreateCommand } from '@/lib/responsibilities';
import { canCreate, useWorkspace } from './workspace-provider';
import { ButtonLink, Disclosure, EmptyState, PageHeading, Panel } from './ui';
import { Icon } from './icon';
import { dispatchResponsibilityDraft } from '../lib/responsibility-draft-request';
import { ResponsibilitySaveFeedback, ResponsibilitySaveFooter } from './responsibility-save-feedback';
const FormSchema = z.object({ title: z.string().trim().min(1,'Give the work record a name.').max(180), description: z.string().trim().max(5000), siteId: z.string().min(1,'Choose an assigned site.'), startsAt: z.string().min(1,'Choose the start of the service window.'), endsAt: z.string().min(1,'Choose the end of the service window.'), acceptancePolicy: z.string().trim().max(5000), requirements: z.array(z.object({ description: z.string().trim().min(1,'Describe the item or service.').max(1000), quantity: z.string().regex(/^[1-9][0-9]*$/,'Use a positive whole number.').refine(v=>Number(v)<=1_000_000,'Quantity is too large.'), unit: z.string().trim().min(1,'Add a unit.').max(48), evidenceRule: z.string().trim().max(2000) })).max(100) });
type FormValues = z.infer<typeof FormSchema>;
export function ResponsibilityCreate() {
  const { session, getToken, drafts } = useWorkspace(); const actionSites = session.sites.filter(site => session.actor.actionSiteIds.includes(site.id)); const router = useRouter(); const client = useQueryClient();
  const [error, setError] = useState<RequestError | null>(() => drafts.has('responsibility-request') ? new RequestError('UNCONFIRMED','An earlier draft request has not been confirmed in this workspace. Check that same request before creating another.') : null); const [operation, setOperation] = useState<Operation | null>(null); const [inFlight, setInFlight] = useState(false); const sending = useRef(false); const mounted = useRef(true); const request = useRef<{ key: string; body: unknown } | null>((drafts.get('responsibility-request') as { key: string; body: unknown } | undefined) ?? null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const retained = drafts.get('new-responsibility') as FormValues | undefined;
  const form = useForm<FormValues>({ resolver: zodResolver(FormSchema), defaultValues: retained ?? { title:'', description:'', siteId:actionSites[0]?.id ?? '', startsAt:'', endsAt:'', acceptancePolicy:'', requirements:[{ description:'', quantity:'1', unit:'items', evidenceRule:'' }] } });
  useEffect(() => { const subscription = form.watch(values => drafts.set('new-responsibility', values)); return () => subscription.unsubscribe(); }, [form, drafts]);
  const { fields, append, remove } = useFieldArray({ control:form.control, name:'requirements' });
  const site = actionSites.find(s=>s.id===form.watch('siteId'));
  const locked = inFlight || Boolean(operation) || Boolean(request.current && error);
  useEffect(() => { const warn = (event: BeforeUnloadEvent) => { if (form.formState.isDirty && !operation) event.preventDefault(); }; window.addEventListener('beforeunload',warn); return()=>window.removeEventListener('beforeunload',warn); }, [form.formState.isDirty,operation]);
  async function send(values: FormValues, retry = false) {
    if (sending.current || operation?.status === 'succeeded' || (!retry && request.current) || (retry && !request.current)) return;
    setError(null);
    const recovering = retry && Boolean(request.current);
    if (!recovering) {
      if (!site) { form.setError('siteId',{message:'Choose a site where you can manage work.'}); return; }
      let startsAt: string, endsAt: string;
      try { startsAt=zonedDateTimeToIso(values.startsAt,site.timeZone); } catch(e) { form.setError('startsAt',{message:e instanceof LocalTimeError ? e.message : 'The site time zone could not be verified.'},{shouldFocus:true}); return; }
      try { endsAt=zonedDateTimeToIso(values.endsAt,site.timeZone); } catch(e) { form.setError('endsAt',{message:e instanceof LocalTimeError ? e.message : 'The site time zone could not be verified.'},{shouldFocus:true}); return; }
      if (Date.parse(endsAt)<=Date.parse(startsAt)) { form.setError('endsAt',{message:'The service window must end after it starts.'},{shouldFocus:true}); return; }
      const command = newCreateCommand({ title:values.title, description:values.description, siteId:values.siteId, window:{ startsAt,endsAt,timeZone:site.timeZone }, acceptancePolicy:values.acceptancePolicy, requirements:values.requirements.map(r=>({ id:crypto.randomUUID(), description:r.description, quantity:Number(r.quantity), unit:r.unit, evidenceRule:r.evidenceRule })) });
      const parsed=CreateResponsibilityCommandSchema.safeParse(command);
      if (!parsed.success) { setError(new RequestError('INVALID_DRAFT','Review the dates, quantities and required fields before saving.')); return; }
      request.current={key:crypto.randomUUID(),body:parsed.data};
    }
    const original = request.current!;
    drafts.set('responsibility-request', original);
    sending.current=true; setInFlight(true);
    try {
      const result = await dispatchResponsibilityDraft(original, getToken, recovering);
      if (result.kind === 'observed') {
        if (mounted.current) setOperation(result.operation);
        if (result.operation.status === 'succeeded' && result.operation.aggregateId) {
          drafts.delete('new-responsibility'); drafts.delete('responsibility-request');
          void client.invalidateQueries({queryKey:['responsibilities']});
          if (mounted.current) router.push(`/app/responsibilities/${encodeURIComponent(result.operation.aggregateId)}`);
        }
      } else {
        if (mounted.current) setError(result.error);
        if (!result.retainOriginal) { request.current=null; drafts.delete('responsibility-request'); }
        if (result.error.fields && !result.retainOriginal) for (const name of Object.keys(result.error.fields)) {
          const key=name.replace(/^payload\./,'');
          if (key in values) form.setError(key as keyof FormValues,{message:'Check this value and try again.'});
        }
      }
    } finally { sending.current=false; if (mounted.current) setInFlight(false); }
  }
  const fieldError=(name:keyof FormValues)=>form.formState.errors[name]?.message;
  if (!canCreate(session)) return <EmptyState title="Your current access cannot create work records." icon="shield-lock" action={<ButtonLink href="/app/responsibilities" secondary>Back to records</ButtonLink>}>An owner or operations manager needs permission to manage work at a site. Permission to view a site does not grant that access.</EmptyState>;
  return <><Link href="/app/responsibilities" className="back-link"><Icon name="arrow-left"/>Records</Link><PageHeading title="Create a work record" description="Start with a clear outcome. Authority and supplier commitments come separately."/><form onSubmit={form.handleSubmit(values=>send(values))} noValidate><div className="detail-columns"><div><Panel title="Outcome & place"><fieldset disabled={locked} className="form-grid"><label className="field form-wide">Record name<input {...form.register('title')} placeholder="For example, equipment for the annual gathering" maxLength={180} aria-invalid={!!fieldError('title')} aria-describedby="title-error"/><span id="title-error" className="field-error">{fieldError('title')}</span></label><label className="field form-wide">What needs to happen?<textarea {...form.register('description')} rows={3} placeholder="Describe the outcome and the details the team needs." maxLength={5000}/></label><label className="field form-wide">Site<select {...form.register('siteId')} aria-invalid={!!fieldError('siteId')}><option value="" disabled>Choose a site</option>{actionSites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}</select><span className="field-error">{fieldError('siteId')}</span></label><label className="field">Service window starts<input type="datetime-local" {...form.register('startsAt')} aria-invalid={!!fieldError('startsAt')}/><small>{site?.timeZone ?? 'Choose a site first'}</small><span className="field-error">{fieldError('startsAt')}</span></label><label className="field">Service window ends<input type="datetime-local" {...form.register('endsAt')} aria-invalid={!!fieldError('endsAt')}/><small>Time at the selected site</small><span className="field-error">{fieldError('endsAt')}</span></label></fieldset></Panel>
  <Panel title="Requirements" action={<span className="fine">{fields.length} / 100</span>}><fieldset disabled={locked} className="requirements-editor">{fields.map((field,index)=><div className="requirement-editor" key={field.id}><div className="requirement-editor-heading"><h3>Requirement {index+1}</h3><button type="button" className="icon-button" aria-label={`Remove requirement ${index+1}`} onClick={()=>remove(index)}><Icon name="close"/></button></div><label className="field">Item or service<input {...form.register(`requirements.${index}.description`)} placeholder="What is needed?" aria-invalid={!!form.formState.errors.requirements?.[index]?.description}/><span className="field-error">{form.formState.errors.requirements?.[index]?.description?.message}</span></label><div className="form-grid"><label className="field">Quantity<input {...form.register(`requirements.${index}.quantity`)} inputMode="numeric" aria-invalid={!!form.formState.errors.requirements?.[index]?.quantity}/><span className="field-error">{form.formState.errors.requirements?.[index]?.quantity?.message}</span></label><label className="field">Unit<input {...form.register(`requirements.${index}.unit`)} placeholder="chairs, tables, hours…" aria-invalid={!!form.formState.errors.requirements?.[index]?.unit}/><span className="field-error">{form.formState.errors.requirements?.[index]?.unit?.message}</span></label></div><label className="field">Evidence needed<textarea {...form.register(`requirements.${index}.evidenceRule`)} rows={2} placeholder="How will the quantity and condition be checked?"/></label></div>)}<button type="button" className="button secondary" disabled={fields.length>=100} onClick={()=>append({description:'',quantity:'1',unit:'items',evidenceRule:''})}><Icon name="plus"/>Add requirement</button></fieldset></Panel>
  <Panel title="Acceptance policy"><fieldset disabled={locked}><label className="field">What counts as done?<textarea {...form.register('acceptancePolicy')} rows={4} placeholder="Name the checks, evidence and authorized person needed to accept the work." maxLength={5000}/><small>A photo or delivery update alone does not authorize acceptance.</small></label></fieldset></Panel></div><aside><Panel title="A clear starting point"><ol className="preparation-list"><li><Icon name="clipboard"/><div><strong>Record the outcome</strong><p>Keep scope, timing and evidence in one place.</p></div></li><li><Icon name="key"/><div><strong>Begin as a draft</strong><p>No supplier message, reservation or payment is authorized.</p></div></li><li><Icon name="users"/><div><strong>Review the next steps</strong><p>Current terms and authority are separate decisions.</p></div></li></ol><Disclosure title="How this draft is saved"><p>Save draft records this outcome in your authenticated workspace. Unsaved changes stay in this signed-in workspace’s memory while you navigate. Refreshing or signing out clears them.</p></Disclosure></Panel></aside></div>
  <ResponsibilitySaveFeedback error={error} requestKey={request.current?.key ?? null} operation={operation} busy={inFlight} onCheck={() => void send(form.getValues(), true)} />
  <ResponsibilitySaveFooter operation={operation} requestKey={request.current?.key ?? null} busy={inFlight} locked={locked} dirty={form.formState.isDirty} /></form></>;
}
