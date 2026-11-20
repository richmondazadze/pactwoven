import type { z } from 'zod';
import type { NativeDelegationClaimSelector, NativeDelegationTarget } from '../../../packages/db/src/native-delegation-repository';
import type * as S from '../../../packages/db/src/native-root-instruction-schema';

type Command<C extends z.ZodType, R extends z.ZodType> = (selector: NativeDelegationClaimSelector, command: z.infer<C>) => Promise<z.infer<R>>;
export interface DelegatedInstructionCoordinatorPort {
  workV3(selector: NativeDelegationClaimSelector): Promise<z.infer<typeof S.NativeRootWorkV3Schema>>;
  checkpointV3: Command<typeof S.NativeRootCheckpointV3CommandSchema, typeof S.NativeRootCheckpointV3ReceiptSchema>;
  yieldV3: Command<typeof S.NativeRootYieldV3CommandSchema, typeof S.NativeRootYieldV3ReceiptSchema>;
  inputsV3: Command<typeof S.NativeRootInputsV3CommandSchema, typeof S.NativeRootInputsV3ReceiptSchema>;
  completeV3: Command<typeof S.NativeRootCompleteV3CommandSchema, typeof S.NativeRootCompleteV3ReceiptSchema>;
  handoffV3: Command<typeof S.NativeRootHandoffV3CommandSchema, typeof S.NativeRootHandoffV3ReceiptSchema>;
  refreshV3: Command<typeof S.NativeRootRefreshV3CommandSchema, typeof S.NativeRootRefreshV3ReceiptSchema>;
  refreshDispatchV3: Command<typeof S.NativeRootRefreshDispatchV3CommandSchema, typeof S.NativeRootRefreshV3ReceiptSchema>;
  refreshOperationV3(target: NativeDelegationTarget, lookup: z.infer<typeof S.NativeRootRefreshV3LookupSchema>): Promise<z.infer<typeof S.NativeRootRefreshV3ReceiptSchema> | null>;
}
export interface DelegatedInstructionSpecialistPort {
  materialsV3(selector: NativeDelegationClaimSelector): Promise<z.infer<typeof S.NativeRootMaterialsV3Schema>>;
  resultV3: Command<typeof S.NativeDelegationPublicationV3Schema, typeof S.NativeDelegationPublicationV3ReceiptSchema>;
}
