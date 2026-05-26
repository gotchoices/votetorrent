---
phase: 12-sql-side-digest-migration
plan: 02
subsystem: authority-engine, network-engine
tags: [typescript, digest, sql, authority-engine, network-engine, invite-flow]

requires:
  - phase: 12-sql-side-digest-migration
    plan: 01
    provides: Invite interface without digest field, AdminDigestArgs, generateSigningNonce, two-path startSigningSession

provides:
  - Authority-engine with zero JS digest() calls (D-02, D-04, D-16, D-19)
  - SQL Digest() in InviteSlot INSERT VALUES for CID computation (D-04)
  - proposeAdmin using AdminDigestArgs for startSigningSession (D-16)
  - saveInviteWithSigning reversed order: nonce -> InviteSlots -> AdminSigning (D-19)
  - respondToInvite querying InviteSlot by InviteKey+Type for CID (D-05)

affects: [12-03, 12-04]

tech-stack:
  added: []
  patterns: [sql-side-digest, nonce-first-invite-flow, invite-slot-cid-readback]

key-files:
  created: []
  modified:
    - packages/vote-engine/src/authority/authority-engine.ts
    - packages/vote-engine/src/network/network-engine.ts

key-decisions:
  - "InviteSlot CID computed entirely by SQL Digest() in VALUES clause — JS no longer computes or stores CID"
  - "saveInviteWithSigning order reversed per D-19: generateSigningNonce first, save InviteSlots second, startSigningSession third"
  - "respondToInvite reads CID from InviteSlot table by InviteKey+Type instead of invite.digest field"

patterns-established:
  - "saveAuthorityInvite: Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce) — 5 fields alphabetical"
  - "saveOfficerInvite: Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce, :type) — 6 fields alphabetical"
  - "respondToInvite: SELECT Cid FROM InviteSlot WHERE InviteKey = :inviteKey AND Type = :type with null guard"

requirements-completed: [D-02, D-03, D-04, D-05, D-16, D-19]

duration: 12min
completed: 2026-05-26
---

# Phase 12 Plan 02: Authority-engine and Network-engine SQL-side Digest Migration Summary

**Migrated authority-engine to zero JS digest calls with SQL Digest() for InviteSlot CID computation and nonce-first invite flow; updated network-engine respondToInvite to query InviteSlot by InviteKey+Type**

## Performance

- **Duration:** ~12 min
- **Completed:** 2026-05-26
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Removed `import { digest } from '../database/digest.js'` from authority-engine (D-02)
- Added `AdminDigestArgs` import to authority-engine type imports
- Removed `digest:` property from `createOfficerInvite` return object (D-02)
- Removed `digest:` property from `createAuthorityInvite` return object (D-02)
- Updated `proposeAdmin` to construct `AdminDigestArgs` and pass to `startSigningSession` (D-16)
- Restructured `saveInviteWithSigning` to nonce-first order: `generateSigningNonce()` → InviteSlots → `startSigningSession(null)` (D-19)
- `saveAuthorityInvite` SQL now uses `Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce)` in VALUES (D-04)
- `saveOfficerInvite` SQL now uses `Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce, :type)` in VALUES (D-04)
- `respondToInvite` replaced `invite.invite.digest` with `SELECT Cid FROM InviteSlot WHERE InviteKey = :inviteKey AND Type = :type` query with null guard (D-05)

## Task Commits

1. **Task 1: Authority-engine migration** - `e911641` (feat)
2. **Task 2: Network-engine respondToInvite CID readback** - `b7b4681` (feat)

## Files Created/Modified

- `packages/vote-engine/src/authority/authority-engine.ts` - Zero JS digest calls; SQL Digest() CIDs; nonce-first flow; AdminDigestArgs
- `packages/vote-engine/src/network/network-engine.ts` - respondToInvite queries InviteSlot for CID

## Decisions Made

- `nonce` bind param serves double duty in InviteSlot INSERT: used both in `Digest(...)` for CID and as the `SigningNonce` column value (`:nonce` replaces the former `:signingNonce` key)
- Alphabetical field ordering enforced in SQL Digest() calls per D-07d: expiration, inviteKey, inviteSignature, name, nonce (authority), then type appended for officer

## Deviations from Plan

None — plan executed exactly as written.

## Pre-existing Test Failures (from Plan 01)

The test suite at commit 616866c (Plan 01 baseline) already had 9 failing tests related to:
- `createOfficerInvite` / `createAuthorityInvite` `invite.digest` expectations (stale after D-01 removed digest from Invite interface)
- `saveInviteWithSigning` scope tests referencing `invite.digest`
- `SigningStartSigningSessionBuilder` tests using old `setDigest` API (migrated in Plan 01)

These 9 pre-existing failures are tracked for resolution in Plan 04 (test file migrations). No new test failures were introduced by this plan.

## Threat Flags

None — all mitigations from the threat register are implemented:
- T-12-04 (InviteSlot CID field ordering): Alphabetical order enforced in SQL Digest() bind params
- T-12-05 (respondToInvite CID lookup): Query by InviteKey+Type with null guard
- T-12-06 (saveInviteWithSigning flow ordering): Nonce-first, InviteSlot-second, AdminSigning-third

## Self-Check

Files confirmed present:
- `packages/vote-engine/src/authority/authority-engine.ts` — modified
- `packages/vote-engine/src/network/network-engine.ts` — modified

Commits confirmed:
- `e911641` feat(12-02): authority-engine SQL-side digest migration
- `b7b4681` feat(12-02): network-engine respondToInvite CID readback via InviteSlot query

## Self-Check: PASSED

---
*Phase: 12-sql-side-digest-migration*
*Completed: 2026-05-26*
