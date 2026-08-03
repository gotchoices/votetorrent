// Digest golden-vector constants for the DEBT-04 cross-runtime parity gate.
//
// WR-15 (17-REVIEW): the vectors moved to src/database/digest-vectors.ts so
// the device-side parity gate (apps/VoteTorrentAuthority persistence-proof.ts,
// via `@votetorrent/vote-engine/rn`) and the Node-side parity spec import the
// SAME module and cannot drift. This file is a re-export kept for the existing
// test import paths — add or edit vectors in src/database/digest-vectors.ts.

export type { DigestVector } from '../../src/database/digest-vectors.js'
export { DIGEST_VECTORS } from '../../src/database/digest-vectors.js'
