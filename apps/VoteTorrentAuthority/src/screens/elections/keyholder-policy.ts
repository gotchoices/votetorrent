/**
 * keyholder-policy.ts: the keyholder policy guard moved to `packages/workflows/src/authority/keyholder-policy.ts`
 * (phase 67 plan 10). This path stays so every existing import, test and the lean rig's hook import keep
 * working; it is a thin binding with the same export names and no logic.
 */
export { validateKeyholderPolicy, KEYHOLDER_POLICY_ERROR_KEY } from "@votetorrent/workflows/authority";
export type { KeyholderPolicyReason, KeyholderPolicyResult } from "@votetorrent/workflows/authority";
