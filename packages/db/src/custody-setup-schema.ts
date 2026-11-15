import type {CustodyCommand,CustodyResult,CustodyRead,CustodyLookup} from '@pactwoven/contracts';
export interface CustodySetupRepository {
  mutate(identityEvidenceId:string,command:CustodyCommand):Promise<CustodyResult>;
  get(identityEvidenceId:string,responsibilityId:string,setupId:string):Promise<CustodyRead|null>;
  recover(identityEvidenceId:string,lookup:CustodyLookup):Promise<CustodyResult|null>;
}
export const custodySetupTables=Object.freeze(['custody_setup_principals','custody_setup_organization_ids','custody_setup_responsibility_ids',
  'custody_setup_specifications','custody_setup_specification_controls','custody_setup_evidence','custody_setup_anchors','custody_setup_records',
  'custody_setup_controls','custody_setup_operations','custody_setup_audit','custody_setup_outbox','custody_setup_evidence_uses'] as const);
export type CustodySetupCapability='writer'|'verifier';
export const custodySetupRoutines=Object.freeze({writer:['pactwoven.custody_setup_command(uuid,jsonb)','pactwoven.custody_setup_read(uuid,text,uuid)',
  'pactwoven.custody_setup_recover(uuid,jsonb)'],verifier:['pactwoven.custody_setup_attest(jsonb)']} as const);
