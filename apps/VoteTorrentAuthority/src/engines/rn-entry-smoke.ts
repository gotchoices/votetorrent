/**
 * rn-entry-smoke.ts — D-03 Metro bundle + Hermes boot smoke
 *
 * Imports every export from @votetorrent/vote-engine/rn and asserts each
 * is a callable function/class at Hermes runtime. Wire to the existing boot-time
 * proof runner (same pattern as persistence-proof.ts) so Metro traces the module.
 *
 * If the Metro bundle fails to compile with these imports, the failure surfaces
 * at bundle time — that is the primary gate (D-03). The runtime typeof check is
 * secondary confirmation on device.
 *
 * Do NOT add a new production screen or alter visual design.
 * Everything is logged under the [rn-smoke] tag.
 */

import {
  NetworksEngine,
  NetworkEngine,
  ElectionsEngine,
  ElectionEngine,
  AuthorityEngine,
  SigningEngine,
  UserEngine,
  DefaultUserEngine,
  KeysTasksEngine,
  SignatureTasksEngine,
  OnboardingTasksEngine,
  InvitationEngine,
  LocalStorageReact,
} from '@votetorrent/vote-engine/rn';

/**
 * D-03 smoke: verify every @votetorrent/vote-engine/rn export resolves as a
 * function/class on Hermes. Returns true if all pass, false if any is missing.
 *
 * Wire to the dev affordance (e.g. persistence-proof-runner.ts boot path) so
 * Metro traces this module in the bundle graph.
 */
export function runRnEntrySmoke(): boolean {
  const exports = [
    NetworksEngine,
    NetworkEngine,
    ElectionsEngine,
    ElectionEngine,
    AuthorityEngine,
    SigningEngine,
    UserEngine,
    DefaultUserEngine,
    KeysTasksEngine,
    SignatureTasksEngine,
    OnboardingTasksEngine,
    InvitationEngine,
    LocalStorageReact,
  ];
  const allDefined = exports.every(e => typeof e === 'function');
  console.log('[rn-smoke] All /rn exports resolve on Hermes:', allDefined ? 'PASS' : 'FAIL');
  return allDefined;
}
