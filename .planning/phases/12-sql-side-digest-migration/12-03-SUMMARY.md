---
phase: 12-sql-side-digest-migration
plan: 03
subsystem: signing
tags: [typescript, digest, builder, mock-engine, signing]

requires:
  - phase: 12-sql-side-digest-migration
    plan: 01
    provides: ISigningEngine interface with digestArgs and generateSigningNonce

provides:
  - AuthoritySaveInviteWithSigningBuilder without invite.digest validation (D-11)
  - MockSigningEngine deterministic behavior with counter-based nonces (D-20/D-21)
  - signing.spec.ts migrated to new ISigningEngine/builder API

affects: [12-04]

tech-stack:
  added: []
  patterns: [deterministic-mock-engine, counter-based-nonce]

key-files:
  created: []
  modified:
    - packages/vote-engine/src/authority/builders/authority-save-invite-with-signing-builder.ts
    - packages/vote-engine/src/signing/mock-signing-engine.ts
    - packages/vote-engine/test/signing.spec.ts

key-decisions:
  - "signing.spec.ts updated as Rule 3 auto-fix — test file would not compile against new ISigningEngine interface"
  - "testDigestArgs AdminDigestArgs constant added alongside testDigest (kept for DB row assertion)"
  - "vote-core rebuilt to update dist/ declarations before TypeScript validation"

patterns-established:
  - "MockSigningEngine nonceCounter: increment-before-return pattern (mock-nonce-N starts at mock-nonce-1)"
  - "startSigningSession: use provided nonce if given (invite flow), else generate via counter (proposeAdmin flow)"

requirements-completed: [D-09, D-10, D-11, D-20, D-21]

duration: 15min
completed: 2026-05-26
---

# Plan 12-03: Builder Layer + Mock Signing Engine Summary

**AuthoritySaveInviteWithSigningBuilder drops invite.digest check (D-11); MockSigningEngine gains deterministic counter-based nonces and generateSigningNonce (D-20/D-21); signing.spec.ts migrated to new ISigningEngine API**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-05-26
- **Tasks:** 2
- **Files modified:** 3 (+ 1 note: vote-core dist rebuilt as prerequisite)

## Accomplishments

- Removed `typeof draft.invite.digest !== 'string'` check from `AuthoritySaveInviteWithSigningBuilder.validateInvite` (D-11)
- Updated error message: "invite must have type, expiration, inviteKey, and inviteSignature" (no digest)
- Added `private nonceCounter = 0` field to MockSigningEngine (D-20)
- Added `generateSigningNonce(): string` returning `mock-nonce-${++this.nonceCounter}` (D-18/D-20)
- Replaced `sign()` throw with `return true` (D-20)
- Replaced `startSigningSession()` throw with deterministic response: uses provided nonce if given (invite flow) or generates via counter (proposeAdmin flow); returns `{ nonce, thresholdReached: true }` (D-21)
- Updated `startSigningSession` signature to `_digestArgs: AdminDigestArgs | null` (not `digest: string`) (D-09)
- Note: SigningStartSigningSessionBuilder was already fully migrated in plan 12-01 (blocking Rule 3 deviation) — no additional changes needed in Task 1 for that file

## Task Commits

1. **Task 1: AuthoritySaveInviteWithSigningBuilder digest removal** - `5d9bc9e` (feat)
2. **Task 2: MockSigningEngine deterministic behavior + signing spec** - `e5b4b64` (feat)

## Files Created/Modified

- `packages/vote-engine/src/authority/builders/authority-save-invite-with-signing-builder.ts` — Removed digest check from validateInvite, updated error message
- `packages/vote-engine/src/signing/mock-signing-engine.ts` — Added nonceCounter, generateSigningNonce, deterministic sign/startSigningSession
- `packages/vote-engine/test/signing.spec.ts` — Migrated to AdminDigestArgs, setDigestArgs, generateSigningNonce in stub, version 2 expectations

## Decisions Made

- signing.spec.ts auto-updated (Rule 3 — blocking TypeScript compilation error)
- `testDigest` string kept alongside new `testDigestArgs` AdminDigestArgs constant — `testDigest` still needed for DB row assertion in blocked quereus#23 test
- vote-core dist rebuilt via `yarn workspace @votetorrent/vote-core build` before TypeScript validation (required because TS compiles against dist/ declarations)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] SigningStartSigningSessionBuilder already migrated — skipped redundant changes**
- **Found during:** Task 1 (read file first)
- **Issue:** Plan 12-01 already applied the full digest→digestArgs migration as a blocking Rule 3 deviation. The builder had KIND_VERSION=2, validateDigestArgs, setDigestArgs, setNonce, and all downstream methods already updated.
- **Fix:** Verified all criteria already met, no-op for builder file
- **Files modified:** None (builder was already correct)
- **Commit:** N/A

**2. [Rule 3 - Blocking] signing.spec.ts updated alongside MockSigningEngine**
- **Found during:** Task 2 (TypeScript compilation check)
- **Issue:** test/signing.spec.ts still used old `setDigest`, `digest: string` in stub engine, `version: 1`, and `include('digest')` in missing fields assertions. Would not compile after MockSigningEngine interface change.
- **Fix:** Migrated stub engine to new ISigningEngine interface, replaced setDigest with setDigestArgs, added testDigestArgs constant, updated version and property name assertions
- **Files modified:** packages/vote-engine/test/signing.spec.ts
- **Committed in:** e5b4b64 (Task 2 commit)

---

**Total deviations:** 2 (1 no-op skip + 1 Rule 3 auto-fix)
**Impact on plan:** No scope creep. Builder was already correct from 12-01; test file update was required for TypeScript compilation.

## Issues Encountered

- vote-core dist/ was stale (compiled against pre-12-01 types). Rebuilt via `yarn workspace @votetorrent/vote-core build` to get updated AdminDigestArgs declarations before TypeScript validation.
- Main repo TypeScript compilation (`yarn workspace @votetorrent/vote-engine tsc`) operates on main repo files, not worktree files — errors from other files (authority.spec.ts, network-engine.ts, authority-engine.ts) are pre-existing cascade errors from D-01 (Invite.digest removal) that will be resolved in plans 12-02 and 12-04.

## User Setup Required

None

## Next Phase Readiness

- Plan 12-04 can proceed: AuthorityEngine and NetworkEngine need their `digest` references cleaned up
- Plans 12-02 handled authority-engine.ts startSigningSession call site updates
- MockSigningEngine is now a valid ISigningEngine implementation — all tests using MockSigningEngine will work without TypeScript errors

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. MockSigningEngine is test-only. No threat flags.

---
*Phase: 12-sql-side-digest-migration*
*Completed: 2026-05-26*
