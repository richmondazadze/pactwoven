import type { z } from 'zod';
import type { NativeDelegationClaimSelector, NativeDelegationTarget } from '../../../packages/db/src/native-delegation-repository';
import type * as S from '../../../packages/db/src/native-root-refresh-schema';

type Command<C extends z.ZodType, R extends z.ZodType> = (selector: NativeDelegationClaimSelector, command: z.infer<C>) => Promise<z.infer<R>>;
export interface DelegatedRefreshCoordinatorPort {
  workV2(selector: NativeDelegationClaimSelector): Promise<z.infer<typeof S.NativeRootWorkV2Schema>>;
  checkpointV2: Command<typeof S.NativeRootCheckpointV2CommandSchema, typeof S.NativeRootCheckpointV2ReceiptSchema>;
  yieldV2: Command<typeof S.NativeRootYieldV2CommandSchema, typeof S.NativeRootYieldV2ReceiptSchema>;
  inputsV2: Command<typeof S.NativeRootInputsV2CommandSchema, typeof S.NativeRootInputsV2ReceiptSchema>;
  completeV2: Command<typeof S.NativeRootCompleteV2CommandSchema, typeof S.NativeRootCompleteV2ReceiptSchema>;
  refresh: Command<typeof S.NativeRootRefreshCommandSchema, typeof S.NativeRootRefreshOperationReceiptSchema>;
  refreshDispatch: Command<typeof S.NativeRootRefreshDispatchCommandSchema, typeof S.NativeRootRefreshOperationReceiptSchema>;
  refreshOperation(target: NativeDelegationTarget, lookup: z.infer<typeof S.NativeRootRefreshOperationLookupSchema>): Promise<z.infer<typeof S.NativeRootRefreshOperationReceiptSchema> | null>;
}
export interface DelegatedRefreshSpecialistPort {
  materialsV2(selector: NativeDelegationClaimSelector): Promise<z.infer<typeof S.NativeRootMaterialsV2Schema>>;
  resultV2: Command<typeof S.NativeDelegationPublicationV2Schema, typeof S.NativeDelegationPublicationV2ReceiptSchema>;
}
