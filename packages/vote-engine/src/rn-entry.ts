// src/rn-entry.ts — RN-safe subpath entry (D-01/D-02)
//
// NetworksEngine is intentionally NOT in src/index.ts or networks/index.ts:
// we export it ONLY here so there is a single controlled re-export path.
// Phase-14 proved Metro CAN bundle NetworksEngine; the omission from the main
// barrel is deliberate to avoid pulling it into non-RN consumers via the default
// '.' subpath.
//
// Do NOT add `export * from './networks/index.js'` here — that would
// double-export MockNetworksEngine alongside NetworksEngine.
export { NetworksEngine } from './networks/networks-engine.js'
export { NetworkEngine } from './network/network-engine.js'
export { ElectionsEngine, peekNextElectionTid } from './elections/elections-engine.js'
export { ElectionEngine } from './election/election-engine.js'
export type { ElectionSubject } from './election/election-engine.js'
export { AuthorityEngine } from './authority/authority-engine.js'
export { SigningEngine } from './signing/signing-engine.js'
export { UserEngine } from './user/user-engine.js'
export { DefaultUserEngine } from './user/default-user-engine.js'
export { KeysTasksEngine } from './tasks/keys-tasks-engine.js'
export { SignatureTasksEngine } from './tasks/signature-tasks-engine.js'
export { OnboardingTasksEngine } from './tasks/onboarding-tasks-engine.js'
export { InvitationEngine } from './invite/invitation-engine.js'
export { LocalStorageReact } from './local-storage-react.js'
export type { DbFactory, EngineContext } from './types.js'
export { H16 } from './utils.js'
