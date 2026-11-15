// Provider flow status controls presentation only. The private verifier authorizes the command.
export type VerificationView = {
  level: string; status: string;
  supportedFirstFactors: { strategy: string }[] | null;
  supportedSecondFactors: { strategy: string }[] | null;
  firstFactorVerification: { status: string | null };
  secondFactorVerification: { status: string | null };
};
export function verificationStage(value: VerificationView): 'password' | 'totp' | 'complete' | 'unsupported' {
  if (value.level !== 'multi_factor') return 'unsupported';
  if (value.status === 'needs_first_factor') return value.supportedFirstFactors?.some(factor => factor.strategy === 'password') ? 'password' : 'unsupported';
  if (value.status === 'needs_second_factor') return value.supportedSecondFactors?.some(factor => factor.strategy === 'totp') ? 'totp' : 'unsupported';
  if (value.status === 'complete' && value.firstFactorVerification.status === 'verified' && value.secondFactorVerification.status === 'verified') return 'complete';
  return 'unsupported';
}
