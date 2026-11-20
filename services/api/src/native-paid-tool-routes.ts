import type { Hono } from 'hono';
import { z } from 'zod';
import { DomainError } from '@pactwoven/domain';
import { IdSchema, type Session } from '@pactwoven/contracts';
import { HashSchema } from '../../../packages/contracts/src/financial';
import { PaidToolHumanSnapshotSchema, PaidToolHumanListSchema, PaidToolHumanCommandResponseSchema,
  PaidToolHumanRecoverySchema, PaidToolHumanControlSchema } from '../../../packages/db/src/paid-tool-schema';
import type { PostgresPaidToolHumanRepository } from '../../../packages/db/src/paid-tool-repository';
import { commandDigest } from '../../../packages/domain/src/canonical';
import { projectNativePaidTool } from './native-paid-tool-presentation';
import type { ApiEnv } from './app';

export type NativePaidToolHumanRepository = Pick<PostgresPaidToolHumanRepository, 'list' | 'read' | 'control' | 'recover'>;
const Query = z.strictObject({ siteId: IdSchema });
const Control = PaidToolHumanControlSchema.omit({ operationId: true }).extend({ siteId: IdSchema });
const Recover = z.strictObject({ siteId: IdSchema, commandKey: IdSchema, commandHash: HashSchema });
const base = '/v1/agent-work/:root/purchases';
export function isNativePaidToolHttpRoute(path: string, method: string) {
  const root = '/v1/agent-work/[A-Za-z0-9_-]+/purchases';
  return (new RegExp('^'+root+'(?:/[A-Za-z0-9_-]+)?$').test(path) && ['GET','OPTIONS'].includes(method)) ||
    (new RegExp('^'+root+'/[A-Za-z0-9_-]+/(?:control|recover)$').test(path) && ['POST','OPTIONS'].includes(method));
}
/** Mount behind real session authentication. No signing, broadcast, quote
 * creation or paid-tool approval is exposed by these read/control routes. */
export function registerNativePaidToolRoutes(app: Hono<ApiEnv>, repository?: NativePaidToolHumanRepository,
  now: () => string = () => new Date().toISOString()) {
  const access = (session: Session, siteId: string, mutation = false) => {
    const actor = session.actor;
    if (actor.environment !== 'development' || actor.principalKind !== 'human' || !actor.siteIds.includes(siteId) ||
      !session.sites.some(site => site.id === siteId) || mutation && !actor.actionSiteIds.includes(siteId))
      throw new DomainError('FORBIDDEN', 403, 'Current workspace access is required for this payment.');
    if (!repository) throw new DomainError('SETUP_REQUIRED', 503, 'Paid tools are not connected yet.');
    return { environment: 'development' as const, organizationId: actor.organizationId, siteId };
  };
  const project = async (session: Session, root: string, siteId: string, raw: unknown, operationId?: string) => {
    const { currentInstructionRevision, evidenceAvailable, ...snapshot } = PaidToolHumanSnapshotSchema.parse(raw);
    if (operationId && snapshot.operationId !== operationId) throw new DomainError('EVIDENCE_STALE',409,'Refresh the original payment.');
    return projectNativePaidTool(session, root, siteId, snapshot, now(), { currentInstructionRevision, evidenceAvailable });
  };
  function query(url: string) {
    const p = new URL(url).searchParams;
    if ([...p.keys()].some(key => p.getAll(key).length !== 1)) throw new DomainError('VALIDATION_FAILED',422,'Use each payment filter once.');
    return Query.parse(Object.fromEntries(p));
  }
  app.get(base, async c => {
    c.header('Cache-Control','private, no-store');
    const rootTaskId=IdSchema.parse(c.req.param('root')), {siteId}=query(c.req.url), session=c.get('session'), scope=access(session,siteId);
    const raw=PaidToolHumanListSchema.parse(await repository!.list(session.actor,rootTaskId,siteId));
    if (raw.rootTaskId!==rootTaskId || new Set(raw.items.map(x=>x.operationId)).size!==raw.items.length)
      throw new DomainError('EVIDENCE_STALE',409,'Refresh the original work and payments.');
    return c.json({scope,rootTaskId,purchases:await Promise.all(raw.items.map(value=>project(session,rootTaskId,siteId,value)))});
  });
  app.get(base+'/:id', async c => {
    c.header('Cache-Control','private, no-store');
    const rootTaskId=IdSchema.parse(c.req.param('root')), id=IdSchema.parse(c.req.param('id')),
      {siteId}=query(c.req.url), session=c.get('session'), scope=access(session,siteId);
    return c.json({scope,rootTaskId,purchase:await project(session,rootTaskId,siteId,await repository!.read(session.actor,id),id)});
  });
  app.post(base+'/:id/control', async c => {
    c.header('Cache-Control','private, no-store');
    const rootTaskId=IdSchema.parse(c.req.param('root')), operationId=IdSchema.parse(c.req.param('id')),
      {siteId,...body}=Control.parse(c.get('requestBody')), session=c.get('session'), scope=access(session,siteId,true);
    // Verify URL affinity before any mutation, not only after its response.
    await project(session,rootTaskId,siteId,await repository!.read(session.actor,operationId),operationId);
    const command={operationId,...body}, expectedHash=await commandDigest({namespace:'pactwoven.paid-tool-command.v1',command});
    const result=PaidToolHumanCommandResponseSchema.parse(await repository!.control(session.actor,command));
    if (result.receipt.commandKey!==command.commandKey || result.receipt.commandHash!==expectedHash ||
      result.receipt.previousVersion!==command.expectedVersion || result.receipt.version!==command.expectedVersion+1 ||
      result.snapshot.version<result.receipt.version) throw new DomainError('EVIDENCE_STALE',409,'Recover the original payment action before trying another.');
    return c.json({scope,rootTaskId,purchase:await project(session,rootTaskId,siteId,result.snapshot,operationId)});
  });
  app.post(base+'/:id/recover', async c => {
    c.header('Cache-Control','private, no-store');
    const rootTaskId=IdSchema.parse(c.req.param('root')), operationId=IdSchema.parse(c.req.param('id')),
      {siteId,...input}=Recover.parse(c.get('requestBody')), session=c.get('session'), scope=access(session,siteId);
    const result=PaidToolHumanRecoverySchema.parse(await repository!.recover(session.actor,rootTaskId,siteId,{kind:'control',operationId,...input}));
    if (result && (!result.receipt || result.receipt.commandKey!==input.commandKey || result.receipt.commandHash!==input.commandHash ||
      result.snapshot.version<result.receipt.version)) throw new DomainError('EVIDENCE_STALE',409,'The original payment action could not be verified.');
    return c.json({scope,rootTaskId,recovery:result?{purchase:await project(session,rootTaskId,siteId,result.snapshot,operationId),receipt:result.receipt}:null});
  });
}
