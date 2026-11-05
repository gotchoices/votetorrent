// src/intake/index.ts — named-export barrel for the intake module (D-03,
// D-04, D-29, D-32, D-46).
//
// Named exports only — NEVER `export *` — mirroring the crypto module's
// barrel discipline (src/crypto/index.ts). The module-level
// `pickCurrentEncryptionKey` helper (recipients.ts) stays OFF this barrel:
// it exists for `IntakeEngine.getOfficerEncryptionKeyStatus`'s own read,
// not as a public API.
//
// This module is deliberately NOT on `src/browser-entry.ts` — the Phase 50
// dashboard is read-only and has no consumer for a signing/vault-backed
// seam. A future plan that needs it there should add the line explicitly.

export { IntakeError, REASSOCIATION_MODES, DEFAULT_REASSOCIATION_MODE, REST_BRIDGE_URL_MAX_LENGTH } from './types.js'
export type {
  IntakeErrorCode,
  IntakeSignCallback,
  ReassociationMode,
  ReassociationMatchMethod,
  ReassociationRoute,
  IntakeRecipientDroppedKey,
  IntakeRecipientSet,
  OfficerEncryptionKeyRegistration,
  OfficerEncryptionKeyStatus,
  IntakeSealer,
  IntakeOpenFailureReason,
  IntakeOpenResult,
  IntakeOpener,
  AuthorityIntakePolicyView,
  AuthorityIntakePolicyInput
} from './types.js'

export { intakeQueryPortFromDb, intakeQueryPortFromStrandPort } from './query-port.js'
export type { IntakeQueryPort } from './query-port.js'

export { resolveIntakeRecipients } from './recipients.js'

export { createIntakeSealer, createIntakeOpener } from './sealing.js'

export { isValidRestBridgeUrl, normalizeIntakePolicyRow, readIntakePolicyFrom, reassociationRouteFor } from './policy.js'

export { IntakeEngine } from './intake-engine.js'
