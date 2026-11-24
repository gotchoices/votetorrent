/**
 * control-schema-recovery.ts — binding. The predicate moved to `@votetorrent/workflows`
 * (packages/workflows/src/common/control-schema-recovery.ts, spike 105) so both apps and the vt CLI share
 * one copy; its header carries the measured failures and why a recreate is safe for the Voter.
 * This path stays for the existing test and for the lean rig (tools/lean-rig/part1/hr5-peer.ts imports it
 * by URL). The provider no longer imports it: it reaches the predicate through the shared bootCadreNode.
 */
export { isUnrestorableControlSchemaError } from '@votetorrent/workflows';
