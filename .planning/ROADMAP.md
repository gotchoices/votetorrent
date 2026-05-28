# Roadmap: VoteTorrent — Milestones v1.0 + v1.1

**Milestones covered:** v1.0 (Schema for the MVP), v1.1 (Builder pattern for engine payloads)
**Phases:** 12 total (1–6 = v1.0, 7–10 = v1.1 builders, 11 = v1.1 digest unification, 12 = SQL-side digest migration)
**Requirements covered:** 51 / 51 (v1.0) ✓ + 24 / 24 (v1.1) ✓

---

# Milestone v1.0 — Schema for the MVP

**Status:** Complete (2026-05-25). Quereus 3.1.2 unblock landed — 288 passing / 0 failing / 17 pending.

## Phase Overview

| # | Phase | Goal | Requirements | Success Criteria |
|---|-------|------|--------------|------------------|
| 1 | Schema Adoption & Fixes | 8/8 | Complete | 2026-05-18 |
| 2 | Package Upgrade | 2/2 | Complete | 2026-05-21 |
| 3 | Network, Authority & Signing Engines | Implement core engines with real crypto | NET-01–04, AUTH-01–08 | Complete 2026-05-25 |
| 4 | User Engine | Implement all UserEngine and DefaultUserEngine methods | USER-01 – USER-08 | Complete 2026-05-25 |
| 5 | Elections & Tasks Engines | Implement election lifecycle and task engines | ELEC-01–08, TASK-01–06 | Complete 2026-05-25 |
| 6 | Integration Test Coverage | Full test suite for all implemented engines | TEST-01 – TEST-05 | Complete 2026-05-25 |

**Milestone v1.0 status (2026-05-25):** All 6 phases complete. Quereus bumped 2.9.0 → 3.1.2; 223 tests unskipped; schema adapted for eager constraint evaluation (EXISTS→context booleans, insert reordering, context variable qualification). Suite: 288 passing / 0 failing / 17 pending (11 election pipeline, 4 createAuthority invite flow, 1 ProposedNetwork PK, 1 quereus 3.x primary key() behavior).

---

### Phase 1: Schema Adoption & Fixes

**Goal:** Replace `votetorrent.qsql` with the new comprehensive schema from `.qsql.temp`, fixing all syntax errors, logic bugs, and missing elements so the schema loads and validates cleanly under quereus 2.9.0.

**Requirements:** SCHEMA-01 – SCHEMA-15

**Plans:** 8/8 plans complete

- [x] 01-01-PLAN.md — Adopt votetorrent.qsql.temp as the new votetorrent.qsql (verbatim file replacement)
- [x] 01-02-PLAN.md — Fix SCHEMA-02 syntax errors (TODO/comment prefixes, with-context placement, trailing-comma audit)
- [x] 01-03-PLAN.md — Fix SCHEMA-06/07/08/12 identifier renames (NetworkName, ProposedElection.Id, ProposedBallot.Id, drop ReferenceId)
- [x] 01-04-PLAN.md — Rewrite SCHEMA-03/04/05/11 constraint logic (AdminSignature threshold, ProposedOfficerUser stub, OfficerSignature scope, User first-user count)
- [x] 01-05-PLAN.md — Add SCHEMA-09/10 missing elements (QuestionType view, InviteType view, InviteSlot.Type column + TypeValid)
- [x] 01-06-PLAN.md — Fix D-13..D-16 runtime constraint joins (Ballot/Question/ProposedQuestion DeleteValid, ProposedElection/ProposedElectionRevision UserValid)
- [x] 01-07-PLAN.md — Create schema-load.spec.ts test (SCHEMA-13/14) and delete votetorrent.qsql.temp
- [x] 01-08-PLAN.md — Gap closure (G-01): rewrite seven CHECK sites to use context.now; bind `with context now` at engine DML; add SCHEMA-15

**Success Criteria:**

1. `initDB()` loads the new schema against a quereus 2.9.0 `Database` instance with zero errors or warnings
2. `basics.spec.ts` runs and all schema-level assertions pass (custom functions present, core tables created, constraints evaluated)
3. All 15 identified schema bugs are fixed and documented in the commit message

**Key work:**

- Adopt `votetorrent.qsql.temp` as the new `votetorrent.qsql`
- Fix syntax: `TODO:` → `-- TODO:`, `//TODO` → `-- TODO:`, misplaced `with context` blocks in ProposedOfficer and User
- Fix `AdminSignature` threshold check (remove reference to undefined `AuthoritySignature` table)
- Fix `ProposedOfficerUser` constraint (wrong column references from ProposedOfficer)
- Fix `OfficerSignature.OfficerValid` SQL logic
- Fix `NetworkSignatureTaskExtension.NetworkIdValid` (`NetworkId` → `NetworkName`)
- Fix `ElectionSignatureTaskExtension.ElectionIdValid` (`ProposedElection.ElectionId` → `ProposedElection.Id`)
- Fix `BallotSignatureTaskExtension.BallotIdValid` (`ProposedBallot.BallotId` → `ProposedBallot.Id`)
- Add `QuestionType` view (currently commented out, referenced by Question/ProposedQuestion)
- Add `Type` column to `InviteSlot` (referenced in `InviteSignatureValid`)
- Fix `User.InsertValid` first-user count (`= 1` → `= 0`)
- Fix `Task.MutationValid` (remove non-existent `ReferenceId` column reference)
- Verify `@optimystic/quereus-plugin-crypto` 0.13.0 still provides required custom functions

---

### Phase 2: Package Upgrade

**Goal:** Upgrade `@quereus/quereus` from 0.12.x to 2.9.0 and `@optimystic/quereus-plugin-crypto` from 0.3.0 to 0.13.0; adapt all engine code to the 2.x API so existing tests pass.

**Requirements:** PKG-01 – PKG-04

**Plans:** 2/2 plans complete

- [x] 02-01-PLAN.md — Bump quereus + crypto-plugin dependencies via `yarn up` (PKG-01, PKG-02)
- [x] 02-02-PLAN.md — Extract prepareDb helper, wire NetworksEngine + schema-load.spec, run surgical diagnose-and-fix loop against 2.x API (PKG-03, PKG-04). Task 2 was originally BLOCKED on Phase 1 schema-determinism issue; resolved by 01-08 G-01 closure. Verified 2026-05-21: `yarn test` 7 passing / 0 failing.

**Success Criteria:**

1. `packages/vote-engine/package.json` references `@quereus/quereus@^2.9.0` and `@optimystic/quereus-plugin-crypto@^0.13.0`
2. All existing engine tests (`basics.spec.ts`, `networks.spec.ts`, `authority.spec.ts`, `network.spec.ts`) pass with zero changes to test logic
3. Database initialization (`initDB`) works with the new quereus 2.x `Database` construction and plugin registration API

**Key work:**

- Run `yarn up @quereus/quereus@^2.9.0 @optimystic/quereus-plugin-crypto@^0.13.0`
- Audit quereus 2.x changelog / migration guide for breaking changes in:
  - `Database` constructor options
  - `db.exec` / `db.eval` / `db.prepare()` API surface
  - Plugin registration mechanism (`db.use()` or equivalent)
  - Statement binding syntax (named vs positional params)
  - Error types (`QuereusError`, `MisuseError`)
- Update `database/initialize.ts` for new plugin registration API
- Update all engine methods for any changed `Database` method signatures
- Fix any TypeScript type errors from changed `@quereus/quereus` exports

---

### Phase 3: Network, Authority & Signing Engines

**Goal:** Implement `NetworksEngine`, `AuthorityEngine`, and `SigningEngine` against the real Quereus DB with correct secp256k1 cryptography — network creation, officer signing sessions, and invite flows work end-to-end.

**Requirements:** NET-01 – NET-04, AUTH-01 – AUTH-08

**Plans:** 6 plans — all shipped code. Quereus unblock complete (2026-05-25): tests unskipped, schema adapted for quereus 3.x eager constraint evaluation.

- [x] 03-01-PLAN.md — Hex contract foundation (vote-core JSDoc, toHexKey helper, test fixtures keys.ts) + NetworksEngine EngineContext cache + UserKey.PubKey fix + qsql `K.Key` → `K.PubKey` schema sweep (NET-01..NET-04, AUTH-01 surface; schema prerequisite for AUTH-03/06/08) — **DONE 2026-05-21** (11 passing / 0 failing; NET-01/02 row-level reads downgraded to behavioural assertions due to latent insert-path bug chain documented in 03-01-SUMMARY.md; insert-path fix is Plan 03-05 below)
- [~] 03-05-PLAN.md — Engine insert-path migration: **PARTIAL CLOSEOUT 2026-05-21**. Schema-side correctness landed (7 type-enum view rewrites at `7ba9354`; 33 bare `Tid,` → `context.Tid,` disambiguation at `fae9cd0`). Engine-side `db.eval` → `db.exec` migration REVERTED after probe surfaced 3 additional latent stages (stage 6: `check on delete` ignored; stage 7: `IN (subquery)` broken in CHECK contexts; stage 8: `json_array_elements_text` phantom function). NET-01 row-level proof still blocked. See 03-05-SUMMARY.md § Issues Encountered #1-#3.
- [~] 03-06 (no PLAN.md) — Engine insert-path v2: **PARTIAL CLOSEOUT 2026-05-22**. NetworksEngine.create() migrated to db.exec + per-INSERT envelopes + monotonic Tid. 4 NET tests `it.skip` with quereus#23 links. See 03-06-SUMMARY.md.
- [~] 03-02-PLAN.md — AuthorityEngine hex-encoded invites, OfficerInviteShare/AuthorityInviteShare types, real signing in proposeAdmin, null guard + signer-list joins in getAdminDetails/getDetails (AUTH-01..AUTH-05) — **PARTIAL CLOSEOUT 2026-05-22** (code complete at `00f3fe2`; tests carried in 03-04)
- [~] 03-03-PLAN.md — SigningEngine signerKey binding fix, removed unreachable return, transactional threshold completion with ConstraintError catch on AdminSignature PK violation (AUTH-06..AUTH-08) — **PARTIAL CLOSEOUT 2026-05-22** (code complete at `41f5f67`; tests carried in 03-04)
- [~] 03-04-PLAN.md — authority.spec.ts bodies for all 7 method-named describe blocks — **PARTIAL CLOSEOUT 2026-05-22**. 13 new passing tests (12 pure-crypto AUTH-01/02 + 1 AUTH-03 guard); 18 new `it.skip` (16 on quereus#23, 2 on Phase 4 USER-07). 30 passing / 0 failing / 207 pending. See 03-04-SUMMARY.md.

**Wave structure:** Wave 1 = {03-01} → Wave 1.5 partial = {03-05} (schema-side improvements landed; engine-side migration paused) → Wave 1.6 = {03-06} (NEW — engine insert-path v2, closes the latent chain; blocks all subsequent Wave 2/3 work) → Wave 2 = {03-02, 03-03} (parallel, no file overlap) → Wave 3 = {03-04}

**Success Criteria:**

1. `NetworksEngine.create()` completes without error: Network, Authority, Admin, Officer, User, and UserKey rows all inserted correctly with hex-encoded keys
2. `SigningEngine.sign()` stores a valid `OfficerSignature` row that passes the `SignatureValid` constraint; threshold completion inserts an `AdminSignature`
3. `AuthorityEngine.createOfficerInvite()` creates an `InviteSlot` with correct CID and signature; `saveInviteWithSigning()` inserts an InviteSlot row whose hex-encoded `InviteKey` and `InviteSignature` fields are persisted and the row passes the Phase-3-applicable schema constraints (the `respondToInvite()` portion of the prior wording belongs to Phase 4 / USER-07 and is tracked there)
4. `authority.spec.ts` covers all 7 AuthorityEngine methods and passes

**Key work:**

- Schema sweep: rename every `UserKey K ... K.Key` reference to `K.PubKey` in `packages/vote-core/schema/votetorrent.qsql` (UserKey's column is `PubKey` per qsql:571 — 17 latent CHECK / JOIN sites)
- Fix `UserKey.PubKey` column reference in `NetworksEngine.create()`
- Add `hash → EngineContext` cache map in `NetworksEngine`; `open()` returns cached context
- Replace `.toString()` key serialization with `bytesToHex` throughout AuthorityEngine
- Remove `invitePrivate` from public return type after invite creation
- Replace `proposeAdmin()` dummy signatures with real secp256k1 sign calls
- Fix `getAdminDetails()` null guard on missing ProposedAdmin
- Populate signer lists in `getDetails()`/`getAdminDetails()` from `OfficerSignature` join (ordering: `AdminEffectiveAt desc limit 1` — AdminSigning has no `Now` column; correction made during 03-checker revision)
- Fix `SigningEngine.sign()`: `key:` → `signerKey:` parameter name
- Remove unreachable `return false` in `SigningEngine.sign()`
- Implement threshold completion: insert `AdminSignature` when count ≥ threshold (transactional BEGIN/COMMIT/ROLLBACK wrap; PK-violation catch for idempotent threshold completion)

---

### Phase 4: User Engine

**Goal:** Implement all `UserEngine` and `DefaultUserEngine` methods so user CRUD, key management, and invite acceptance are backed by the Quereus DB.

**Status:** [~] partial — code complete; DB-bound tests blocked on quereus#23. See `.planning/phases/04-user-engine/04-SUMMARY.md`.

**Plans:** 1 (combined SUMMARY only — no per-plan PLAN.md, per assume-fixed directive; mirrors 03-06 closeout shape)

**Requirements:** USER-01 – USER-08

**Success Criteria:**

1. `UserEngine.create()` inserts a `User` row and an initial `UserKey` with a hex-encoded public key and future expiry; the row passes the `UserValid` and `UserKeyValid` constraints
2. `UserEngine.addKey()` and `revokeKey()` succeed and fail appropriately for valid/invalid signing contexts
3. `DefaultUserEngine.getDefaultUser()` and `setDefaultUser()` round-trip through `LocalStorage` correctly

**Key work:**

- Implement `UserEngine.getCurrentUser()` — query `User` by `ctx.user.Id`
- Implement `UserEngine.create()` — generate key pair, hex-encode, insert User + UserKey
- Implement `UserEngine.getUser(id)` — query by primary key
- Implement `UserEngine.revise(update, signature)` — update User name/imageRef with signing context
- Implement `UserEngine.addKey(type, expiry, signature)` — insert UserKey with signing
- Implement `UserEngine.revokeKey(pubKey, signature)` — delete UserKey respecting constraint
- Implement `UserEngine.respondToInvite(slotCid, accept, signature)` — insert `InviteResult` (carries forward the Phase-3-deferred portion of Phase 3 SC-3; Phase 3 Plan 04 leaves `it.skip(...)` markers in `authority.spec.ts > getAuthorityInvites` for the InviteResult-bearing assertions, ready to un-skip once this method ships)
- Implement `DefaultUserEngine.getDefaultUser()` and `setDefaultUser()` via `LocalStorage`
- New test file: `user.spec.ts`

---

### Phase 5: Elections & Tasks Engines

**Goal:** Implement `ElectionsEngine`, `ElectionEngine`, and all three `TasksEngines` so the full election lifecycle (create, revise, add ballots/questions, manage signing tasks) is backed by the Quereus DB.

**Status:** [~] partial — code complete; DB-bound tests blocked on quereus#23 (+ 1 on #21). See `.planning/phases/05-elections-tasks-engines/05-SUMMARY.md`.

**Plans:** 1 (combined SUMMARY only — no per-plan PLAN.md, per assume-fixed directive; mirrors 03-06 / 04 closeout shape)

**Requirements:** ELEC-01 – ELEC-08, TASK-01 – TASK-06

**Success Criteria:**

1. `ElectionsEngine.create()` inserts an `Election` row via signed `AdminSigning`/`AdminSignature`; `list()` returns it
2. `ElectionEngine.addBallot()` and `addQuestion()` insert rows that pass the `MutationValid` constraints
3. `SignatureTasksEngine.getTasks()` returns pending signature tasks for the current user; `completeTask()` invokes `SigningEngine.sign()` and marks the task done

**Key work:**

- Implement `ElectionsEngine.list()` — query `Election` table with summary projection
- Implement `ElectionsEngine.create()` — construct AdminSigning, AdminSignature, then insert Election
- Implement `ElectionEngine.getDetails()` — join Election with current ElectionRevision
- Implement `ElectionEngine.getRevisions()` — query ElectionRevision[] for election
- Implement `ElectionEngine.propose()` — insert ProposedElection / ProposedElectionRevision
- Implement `ElectionEngine.addBallot()` — insert Ballot with signing context
- Implement `ElectionEngine.addQuestion()` — insert Question with signing context
- Implement `ElectionEngine.addOption()` — insert Option with signing context
- Implement `KeysTasksEngine.getTasks()` and `completeTask()`
- Implement `SignatureTasksEngine.getTasks()` and `completeTask()`
- Implement `OnboardingTasksEngine.getTasks()` and `completeTask()`
- New test file: `elections.spec.ts`

---

### Phase 6: Integration Test Coverage

**Status:** [~] partial — code complete; ~200 DB-bound tests blocked on quereus#23 (+1 on #21). See `.planning/phases/06-integration-test-coverage/06-SUMMARY.md`.

**Plans:** 1 (combined SUMMARY only — no per-plan PLAN.md, per assume-fixed directive; mirrors 03-06 / 04 / 05 closeout shape)

**Goal:** Write comprehensive integration tests for all implemented engines, ensuring every major success path and the key bug-fix scenarios are covered by a passing test.

**Requirements:** TEST-01 – TEST-05

**Success Criteria:**

1. `yarn test` in `packages/vote-engine` runs all spec files with zero failures — **✓ (85 passing / 0 failing / 219 pending)**
2. `AuthorityEngine` and `SigningEngine` test files exist and cover all public methods including the threshold signing path — **✓** (authority.spec.ts ships from Phase 3 with 10 active + 92 it.skip; signing.spec.ts NEW in Phase 6 with 5 active + 7 it.skip)
3. `UserEngine` and `ElectionsEngine` test files exist and cover create/read/sign paths end-to-end — **✓** (user.spec.ts Phase 4: 8 active + 9 it.skip; elections.spec.ts Phase 5: 24 active + 14 it.skip)

**Key work (status):**

- ✓ Expand `authority.spec.ts`: ROADMAP-listed method describes shipped in Phase 3 Plan 04; Phase 6 closes out the 59 body-less schema-constraint placeholders with it.skip + quereus#23 annotations.
- ✓ New `signing.spec.ts`: 12 tests covering `startSigningSession`, `sign()` (with AUTH-06/07/08 source-contract verifications), threshold completion, constructor.
- ✓ Expand `network.spec.ts`: 19 active passing tests across NetworkEngine + NetworksEngine sub-suites; 97 body-less placeholders converted to it.skip + #23.
- ✓ New `user.spec.ts` (Phase 4).
- ✓ New `elections.spec.ts` (Phase 5).
- ✓ Verify all tests run cleanly with quereus 3.1.1 in-memory DB.

---

## v1.0 Dependency Graph

```
Phase 1 (Schema)
    └─► Phase 2 (Package Upgrade)
            └─► Phase 3 (Network/Auth/Signing)
                    └─► Phase 4 (User)
                    └─► Phase 5 (Elections/Tasks)
                            └─► Phase 6 (Tests)
```

Phases 4 and 5 can run in parallel after Phase 3 completes (both depend on User tables being stable from Phase 3, but are otherwise independent). Phase 6 runs after both 4 and 5.

---

# Milestone v1.1 — Builder pattern for engine payloads

**Status:** Complete (2026-05-25). 493 passing / 74 pending / 0 failing. 26 builders, 26 fixture dirs, CI grep guard operational.
**Phases:** 6 (7–12).
**Requirements covered:** 24 / 24 (FOUND 4 + VALID 3 + SER 4 + FACT 4 + BUILD 9 + BTEST 3) ✓ + Phase 11 (Digest Unification, D-01..D-11).
**Granularity:** standard.

**Ratified design decisions** (apply to every v1.1 phase; carried verbatim from REQUIREMENTS.md):

- Builder layer is **additive** — direct engine methods stay callable; `commit()` delegates 1:1 to the existing direct method (no parallel write path).
- Builders hold an **`IXxxEngine` reference** (never `EngineContext` / `ctx.db`).
- Setters are **immutable** — each returns a fresh builder instance (new wrapper, shared structural draft) so RN re-renders via `Object.is`. No `subscribe()` API.
- Draft fields are **JSON primitives only** (hex strings for keys, ISO 8601 for dates). No `Date`, `Buffer`, `Uint8Array` on the draft.
- `errors()` returns `readonly BuilderError[]` with `{ path, code, message, kind: 'per-setter' | 'cross-field' }`.
- Drafts version **per-kind** — each concrete builder owns its `static readonly KIND_VERSION`. Envelope: `{ kind, version, draft }`.
- `dispose()` reserved as a no-op in `IBuilder` (future-proof for v1.2+ resource ownership).
- Builders **never construct SQL bind objects** (Quereus colon-prefix quirk stays contained at the engine layer).

## v1.1 Phase Overview

| # | Phase | Goal | Requirements | Success Criteria |
|---|-------|------|--------------|------------------|
| 7 | Builder Foundation + User Beachhead | Lock the IBuilder contract end-to-end and prove it on the lowest-blast-radius engines (DefaultUser + User) | FOUND-01..04, VALID-01..03, SER-01..04, FACT-01..04, BUILD-USER-01, BUILD-USER-02, BTEST-01/02 (User/DefaultUser scope) | 5 |
| 8 | Networks + Elections Builders | Inherit the contract and add concrete builders for Networks + Elections (largest payload surface, builder-returning-engine case) | BUILD-NET-01, BUILD-NET-02, BUILD-ELEC-01, BUILD-ELEC-02, BTEST-01/02 (Net/Elec scope) | 4 |
| 9 | Authority + Signing Builders | Add concrete builders for the highest-blast-radius engines, with explicit security-review gate on SigningEngine draft fields | BUILD-AUTH-01, BUILD-SIGN-01, BTEST-01/02 (Auth/Signing scope) | 4 |
| 10 | NetworkEngine + Tasks Builders + Cross-Cutting Test Infrastructure | Finish remaining builders, land the past-version fixture directory + CI grep guard, run the final equivalence suite | BUILD-TASK-01, BTEST-01..03 (cross-cutting infra) | 5 |
| 11 | Digest Unification | Unified digest helper + authority-engine migration + test placeholder replacement | D-01..D-11 (CONTEXT.md decisions) | 3 |
| 12 | SQL-Side Digest Migration | 4/4 | Complete    | 2026-05-26 |
| 12.1 | Implement Skipped & Stub Tests (INSERTED) | 4/4 | Complete   | 2026-05-27 |

## v1.1 Dependency Graph

```
Phase 7 (IBuilder contract + User/DefaultUser beachhead)
    ├─► Phase 8 (Networks + Elections)
    │       └─► Phase 10 (NetworkEngine + Tasks + Test Infra)
    └─► Phase 9 (Authority + Signing)
            └─► Phase 10 (NetworkEngine + Tasks + Test Infra)
                    └─► Phase 11 (Digest Unification)
                            └─► Phase 12 (SQL-Side Digest Migration)
```

Phase 7 locks the contract — every subsequent phase consumes the same `IBuilder<TInput, TOutput>` shape and helper types. Phases 8 and 9 can run in parallel (no file overlap; distinct engine domains). Phase 10 lands after both, since the past-version fixture directory and CI grep guard sweep every builder shipped in 7/8/9. Phase 11 runs after Phase 10 (depends on all engines being complete). Phase 12 runs after Phase 11 (migrates from JS digest to SQL Digest).

---

### Phase 7: Builder Foundation + User Beachhead

**Goal:** Lock the `IBuilder<TInput, TOutput>` contract and helper types in vote-core, ship per-domain `IXxx<Verb>Builder` interfaces for every mutating method, and prove the pattern end-to-end (validation + serialization + factory + equivalence) by implementing concrete builders for the lowest-blast-radius engines: `DefaultUserEngine` and `UserEngine`.

**Depends on:** Nothing (first v1.1 phase). No dependency on v1.0 closure — builders sit above the engine surface; equivalence tests inherit the v1.0 `it.skip + quereus#23` annotation pattern.

**Requirements:** FOUND-01, FOUND-02, FOUND-03, FOUND-04, VALID-01, VALID-02, VALID-03, SER-01, SER-02, SER-03, SER-04, FACT-01, FACT-02, FACT-03, FACT-04, BUILD-USER-01, BUILD-USER-02, BTEST-01 (User/DefaultUser scope), BTEST-02 (User/DefaultUser scope).

**Success Criteria** (what must be TRUE when this phase completes):

1. `import { IBuilder, BuilderError, MissingField, SerializedBuilder, BuilderValidationError, BuilderAlreadyCommittedError } from '@votetorrent/vote-core'` resolves; every helper type matches the FOUND-01/FOUND-02 shape; no `any` appears in any public builder signature anywhere in vote-core.
2. Every mutating engine method across all engines has a corresponding strongly-typed `IXxx<Verb>Builder` interface declared in its domain `types.ts` (declarations only — concrete classes for non-User engines arrive in Phases 8/9/10). `aegir dep-check` in both vote-core and vote-engine reports zero new runtime dependencies.
3. `DefaultUserEngine.buildSet()` and `UserEngine.buildCreate()/buildRevise()/buildAddKey()/buildRevokeKey()` exist on both real and mock engines; each factory returns a builder that round-trips through `JSON.parse(JSON.stringify(b.toJSON()))` deep-equal, and `Builder.fromJSON(b.toJSON(), engine)` reproduces the same draft and validation state.
4. For every User/DefaultUser builder, the invariant test passes: when `isValid() === true`, `commit()` cannot throw `BuilderValidationError`; calling `commit()` twice throws `BuilderAlreadyCommittedError` synchronously on the second call.
5. Per-builder equivalence smoke test passes (or is annotated with `it.skip + quereus#23` per v1.0 pattern where DB-bound): `await engine.<verb>(payload)` and `await engine.build<Verb>().fromPayload(payload).commit()` produce structurally identical results.

**Key work** (all ratified design decisions in REQUIREMENTS.md apply):

- Create `packages/vote-core/src/common/builder.ts` declaring `IBuilder<TInput, TOutput>`, `BuilderError`, `MissingField`, `SerializedBuilder<TDraft>`, `BuilderValidationError`, `BuilderAlreadyCommittedError`; re-export via `vote-core/src/common/index.ts`.
- Add per-verb `IXxx<Verb>Builder` interface declarations to every domain `types.ts` (authority, network, networks, election, elections, user, signing, tasks) — declarations only; concrete classes for engines other than User/DefaultUser arrive in later phases.
- Add `build<Verb>()` factory **signatures** to every `IXxxEngine` interface in vote-core (additive — no breaking changes).
- Implement concrete builders for the beachhead engines in `packages/vote-engine/src/user/builders/` and `packages/vote-engine/src/user/default-user-engine.ts` (factory only — DefaultUserEngine is a single-file engine; place the builder in `packages/vote-engine/src/user/builders/default-user-set-builder.ts`).
- Add `buildXxx()` factory methods on `DefaultUserEngine`, `UserEngine`, **and** their mock counterparts (FACT-04 mock-engine parity).
- Per-setter sync validators with `BuilderError { kind: 'per-setter' }`; commit-time cross-field validators with `BuilderError { kind: 'cross-field' }`; `commit()` throws `BuilderValidationError` with the full array.
- Implement idempotent commit guard (FACT-03): output cached on first call; second call throws `BuilderAlreadyCommittedError` synchronously before any engine call.
- Implement `toJSON(): SerializedBuilder<TDraft>` returning `{ kind, version, draft }` (engine refs / DB handles / RxJS subjects / non-JSON-primitive values explicitly excluded); `static fromJSON(json, engine)` with strict version-and-kind allowlist dispatch; per-builder `static readonly KIND_VERSION = 1`.
- Create `packages/vote-engine/test/fixtures/builder-drafts/<kind>/v1/` directory **structure** for User/DefaultUser builders (ships empty per SER-03; populated by post-v1.1 schema-changing PRs).
- Per-builder unit tests (~7 each per BTEST-01): empty-builder validity, individual setter validation, missingFields/errors progression, isValid/commit invariant, round-trip serialization, double-commit guard, type-narrowing on `toEngineInput`.
- Per-builder equivalence smoke test per BTEST-02 (1 each, DB-bound assertions inherit `it.skip + quereus#23` where blocked).
- Apply pitfall prevention surface (Pitfalls 1, 2, 3, 4, 5, 6, 7, 8, 10 per PITFALLS.md): commit-delegates-to-direct, draft/executor split, no SQL in builders, isValid covers cross-field, immutable setters, version allowlist dispatch, strongly-typed input/output, JSON primitives only, single validator source of truth.

**Plans:** 5 plans

- [x] 07-builder-foundation-user-beachhead/01-PLAN.md — vote-core builder.ts foundations (IBuilder + helper types + error classes + barrel re-export)
- [x] 07-builder-foundation-user-beachhead/02-PLAN.md — Per-domain IXxx<Verb>Builder interface declarations + build<Verb>() factory signatures across all 8 domain types.ts + past-version fixture dirs (5 empty v1/)
- [x] 07-builder-foundation-user-beachhead/03-PLAN.md — Concrete DefaultUserSetBuilder + buildSet() factories on real/mock DefaultUserEngine + 9-test spec (unskipped equivalence smoke) -- **DONE 2026-05-25** (9 passing / 0 failing / 0 skipped; FACT-04 parity + BTEST-02 equivalence both UNSKIPPED)
- [x] 07-builder-foundation-user-beachhead/04-PLAN.md — 4 concrete UserEngine builders (create/addKey/revise/revokeKey) + factories on real/mock UserEngine + 4x9 spec suites (29 passing + 12 it.skip + quereus#23; SC4 DB-FREE stub-engine tests + FACT-04 parity) -- **DONE 2026-05-25**
- [x] 07-builder-foundation-user-beachhead/05-PLAN.md — Verification (aegir dep-check both packages + Pitfall 2/3/7/8 grep guards + full test suite regression + ROADMAP success-criteria spot-check) -- **DONE 2026-05-25** (all 5 SC PASS; 326 passing / 0 failing / 29 pending; PHASE 7 CODE-COMPLETE)

---

### Phase 8: Networks + Elections Builders

**Goal:** Inherit the locked Phase-7 contract and ship concrete builders for `NetworksEngine`, `NetworkEngine`-adjacent network-creation flows, `ElectionsEngine`, and `ElectionEngine`. Proves two new capability points: a builder whose `commit()` returns a constructed engine instance (`NetworksEngine.buildCreate()` → `INetworkEngine`), and the largest payload surface (Elections).

**Depends on:** Phase 7 (IBuilder contract + helper types).

**Requirements:** BUILD-NET-01, BUILD-NET-02, BUILD-ELEC-01, BUILD-ELEC-02, BTEST-01 (Net/Elec scope), BTEST-02 (Net/Elec scope).

**Note on BUILD-NET-02 scope:** REQUIREMENTS.md lists `respondToInvite` under BUILD-NET-02. Phase 10 owns the cross-cutting test infrastructure; the `NetworkEngine.respondToInvite` builder itself is grouped with the other `NetworkEngine` mutating methods here in Phase 8 (per the ratified mapping). If the implementer finds `respondToInvite` is cleaner shipped alongside Tasks in Phase 10, document the move in the phase SUMMARY and update the traceability table — but the default plan keeps it in Phase 8.

**Success Criteria:**

1. `networksEngine.buildCreate()` exists on both real and mock engines; its `commit()` returns an `INetworkEngine` instance (not just a row payload), and the equivalence smoke test confirms structural parity with the existing direct `NetworksEngine.create()` path.
2. `networkEngine.buildCreateAuthority()`, `buildPinAuthority()`, `buildUnpinAuthority()`, `buildProposeRevision()`, and `buildRespondToInvite()` exist on both real and mock engines; each builder's draft serializes through `toJSON()` / `fromJSON()` round-trip with `KIND_VERSION = 1`.
3. `electionsEngine.buildCreateElection()` and `buildAdjustElection()`, plus `electionEngine.buildProposeBallot()`, `buildProposeRevision()`, `buildInviteKeyholder()`, and `buildRevokeKeyholder()` exist on both real and mock engines; cross-field validators (e.g., `endsAt > startsAt`, threshold ≤ keyholder count) surface via `errors()` with `kind: 'cross-field'`.
4. Per-builder unit tests (~7 each) and one equivalence smoke test per builder all pass or are annotated `it.skip + quereus#23` per v1.0 pattern. No new colon-prefix bind keys appear in any file under `packages/vote-engine/src/**/builders/`.

**Key work** (all ratified design decisions in REQUIREMENTS.md apply):

- Concrete builder classes in `packages/vote-engine/src/networks/builders/create-builder.ts`, `packages/vote-engine/src/network/builders/{create-authority,pin-authority,unpin-authority,propose-revision,respond-to-invite}-builder.ts`, `packages/vote-engine/src/elections/builders/{create-election,adjust-election}-builder.ts`, and `packages/vote-engine/src/election/builders/{propose-ballot,propose-revision,invite-keyholder,revoke-keyholder}-builder.ts`.
- Engine factory methods on real and mock engines (FACT-04 mock parity).
- Per-builder past-version fixture directory layout at `packages/vote-engine/test/fixtures/builder-drafts/<kind>/v1/` (ships empty per SER-03).
- Per-builder unit tests + equivalence smoke tests per BTEST-01/BTEST-02.
- Defaulting / normalisation / hex encoding / SQL binding stay in the direct engine methods (Pitfall 1 prevention — builder layer never re-implements them).
- For BUILD-NET-01 specifically: builder draft excludes the constructed `INetworkEngine` instance from `toJSON()` (the engine is reconstructed at commit time, not serialized).

**Plans:** 4 plans
Plans:

- [x] 08-networks-elections-builders/08-01-PLAN.md — NetworksCreateBuilder (commit returns INetworkEngine)
- [x] 08-networks-elections-builders/08-02-PLAN.md — 5 NetworkEngine builders (createAuthority, pin/unpin, proposeRevision, respondToInvite)
- [x] 08-networks-elections-builders/08-03-PLAN.md — 2 ElectionsEngine + 4 ElectionEngine builders (6 total)
- [x] 08-networks-elections-builders/08-04-PLAN.md — Verification (dep-check, pitfall grep guards, test regression, SC spot-check) -- **DONE 2026-05-25** (all invariants pass; 417 passing / 65 pending / 0 failing; PHASE 8 CODE-COMPLETE)

---

### Phase 9: Authority + Signing Builders

**Goal:** Add concrete builders for the highest-blast-radius engines (`AuthorityEngine` — multi-table Signature cross-cut) and the most security-sensitive engine (`SigningEngine`), with an explicit security-review acceptance criterion confirming no private-key material or signing-scope secrets enter the draft.

**Depends on:** Phase 7 (IBuilder contract). Can run in parallel with Phase 8 (no file overlap; distinct engine domains).

**Requirements:** BUILD-AUTH-01, BUILD-SIGN-01, BTEST-01 (Auth/Signing scope), BTEST-02 (Auth/Signing scope).

**Research flag:** MODERATE — per SUMMARY.md, SigningEngine's existing colon-prefix bind sites and the v1.0 Signature contract gaps may need a focused source-contract pass before SigningEngine builders ship. Trigger plan-phase research if the builder authoring surface depends on a not-yet-locked engine behavior.

**Success Criteria:**

1. `authorityEngine.buildCreateOfficerInvite()`, `buildCreateAuthorityInvite()`, `buildProposeAdmin()`, and `buildSaveInviteWithSigning()` exist on both real and mock engines; each builder's `commit()` delegates verbatim to the corresponding direct method, and the equivalence smoke test confirms identical row shapes (or is annotated `it.skip + quereus#23`).
2. `signingEngine.buildStartSigningSession()` and `buildSign()` exist on both real and mock engines; draft fields are JSON primitives only (hex strings for public keys, ISO 8601 for timestamps, plain strings/numbers for session metadata).
3. **Hard-blocking security gate (BUILD-SIGN-01 acceptance):** an explicit security review of every `SigningEngine` builder draft confirms zero appearance of private-key material, secp256k1 nonces, or signature-scope secrets in `toJSON()` output. Review is documented in the phase SUMMARY with a per-field audit table. This gate must pass before the phase can close out.
4. Per-builder unit tests (~7 each) and one equivalence smoke test per builder all pass or are annotated `it.skip + quereus#23` per v1.0 pattern. No SigningEngine builder imports `@noble/curves` or `@noble/hashes` (Pitfall 8 — hex strings only; key material stays in the SigningEngine).

**Key work** (all ratified design decisions in REQUIREMENTS.md apply):

- Concrete builder classes in `packages/vote-engine/src/authority/builders/{create-officer-invite,create-authority-invite,propose-admin,save-invite-with-signing}-builder.ts` and `packages/vote-engine/src/signing/builders/{start-signing-session,sign}-builder.ts`.
- Engine factory methods on real and mock engines.
- Per-builder past-version fixture directories (ship empty at v1).
- Per-builder unit + equivalence smoke tests.
- **Security audit deliverable for BUILD-SIGN-01:** explicit per-field table in the phase SUMMARY listing every draft field with its type and confirming it carries no key/nonce/scope-secret material. The SigningEngine source's existing `:nonce` colon-prefix sites must NOT migrate into builder drafts (Pitfall 3 + Pitfall security table).

**Plans:** 3 plans
Plans:

- [x] 09-authority-signing-builders/09-01-PLAN.md — 4 AuthorityEngine builders (createOfficerInvite, createAuthorityInvite, proposeAdmin, saveInviteWithSigning)
- [x] 09-authority-signing-builders/09-02-PLAN.md — 2 SigningEngine builders (startSigningSession, sign) + security audit table
- [x] 09-authority-signing-builders/09-03-PLAN.md — Verification (dep-check, pitfall + security grep guards, test regression, SC spot-check) -- **DONE 2026-05-25** (all invariants pass; 464 passing / 71 pending / 0 failing; PHASE 9 CODE-COMPLETE)

---

### Phase 10: NetworkEngine + Tasks Builders + Cross-Cutting Test Infrastructure

**Goal:** Ship the final batch of concrete builders (Tasks engines), land the cross-cutting test infrastructure that protects every prior phase's work — past-version fixture directory layout and a CI grep guard rejecting colon-prefix bind keys in any new file under `packages/vote-engine/src/**/builders/` — and run the final equivalence-suite sweep.

**Depends on:** Phase 7 (IBuilder contract), Phase 8 (Networks/Elections builders to sweep), Phase 9 (Authority/Signing builders to sweep). Runs after both 8 and 9.

**Requirements:** BUILD-TASK-01, BTEST-01 (Tasks scope + sweep), BTEST-02 (Tasks scope + final sweep), BTEST-03 (cross-cutting test infrastructure).

**Success Criteria:**

1. `keysTasksEngine.buildCompleteKeyRelease()`, `signatureTasksEngine.buildCompleteSignature()`, and `onboardingTasksEngine.buildSetOnboardingTaskCompleted()` exist on both real and mock engines; each builder's unit tests + equivalence smoke test pass or are annotated `it.skip + quereus#23` per v1.0 pattern.
2. The past-version fixture directory `packages/vote-engine/test/fixtures/builder-drafts/<kind>/v<n>/` exists for every concrete builder shipped in Phases 7–10 (v1 directories ship empty per SER-03); a CI replay job loads each fixture through `Builder.fromJSON(json, engine)` and asserts `isValid()` or a documented clean failure with a migration note.
3. A CI grep guard rejects any new occurrence of the `:\w+` colon-prefix bind-key pattern in files under `packages/vote-engine/src/**/builders/` (existing engine code outside `builders/` exempt until v1.0 closure sweep). The guard fails the build with an explicit message pointing at Pitfall 3.
4. Final test-budget invariant verified per BTEST-03: total new test count is bounded at ~7 unit + 1 equivalence smoke per builder; existing direct-call test suite untouched (still 85 passing / 0 failing / 219 pending plus the v1.1 additions). Suite size growth reported in the phase SUMMARY.
5. Cross-builder check: for every concrete builder shipped in v1.1, the invariant "if `isValid() === true`, then `commit()` cannot throw `BuilderValidationError`" holds, and the property "calling `commit()` twice throws `BuilderAlreadyCommittedError` synchronously on the second call" holds.

**Key work** (all ratified design decisions in REQUIREMENTS.md apply):

- Concrete builder classes in `packages/vote-engine/src/tasks/builders/{complete-key-release,complete-signature,set-onboarding-task-completed}-builder.ts`.
- Engine factory methods on real and mock Tasks engines.
- Create the past-version fixture directory tree under `packages/vote-engine/test/fixtures/builder-drafts/` for every builder kind in v1.1 (User/DefaultUser/Networks/Network/Elections/Election/Authority/Signing/Tasks); each `<kind>/v1/` ships empty per SER-03, populated by the first post-v1.1 schema-changing PR.
- CI fixture-replay job: load every fixture, call `Builder.fromJSON(json, engine)`, assert `isValid()` (or fail with a structured migration-required error).
- CI grep guard (e.g., in the lint or pretest step): rejects `:\w+` colon-prefix bind keys in any file under `packages/vote-engine/src/**/builders/`. Document the exact regex + exemption rule in the phase SUMMARY.
- Final equivalence smoke-test sweep: confirm every builder's smoke test is either green or annotated `it.skip + quereus#23` per v1.0 pattern; no new `it.skip` reasons introduced beyond the v1.0 set.
- Per-builder unit tests + equivalence smoke tests for Tasks builders per BTEST-01/BTEST-02.

**Plans:** 3 plans
Plans:

- [x] 10-tasks-builders-test-infra/10-01-PLAN.md — 3 Tasks engine builders (completeKeyRelease, completeSignature, setOnboardingTaskCompleted) + engine factories + fixture dirs + tests -- **DONE 2026-05-25** (22 passing + 3 skipped equivalence smokes; FACT-04 parity verified)
- [x] 10-tasks-builders-test-infra/10-02-PLAN.md — Cross-cutting test infrastructure (CI grep guard script + fixture-replay test + package.json wiring) -- **DONE 2026-05-25** (7 passing tests; grep guard rejects colon-prefix bind keys; fixture-replay confirms 26 kind dirs)
- [x] 10-tasks-builders-test-infra/10-03-PLAN.md — Verification (dep-check, all pitfall guards, full suite regression, SC1-SC5 spot-check, milestone v1.1 closeout) -- **DONE 2026-05-25** (all invariants pass; 493 passing / 74 pending / 0 failing; PHASE 10 CODE-COMPLETE; MILESTONE v1.1 CODE-COMPLETE)

---

### Phase 11: Digest Unification

**Goal:** Enable SQL digest alongside JS digest in all engines, converting the JS digest delimiter from `,` to `|` so both digest systems use a consistent separator and SQL validation constraints can fire correctly.

**Depends on:** Phase 10 (all engines complete).

**Requirements:** D-01..D-11 (CONTEXT.md decisions — phase added post-v1.1 roadmap).

**Success Criteria:**

1. A unified `digest()` helper in `packages/vote-engine/src/database/digest.ts` produces output identical to the SQL `Digest()` function registered in `initialize.ts` (proven by JS-vs-SQL cross-verification test).
2. Authority-engine no longer imports `Digest` from `@optimystic/quereus-plugin-crypto`; all 5 call sites use the local `digest()` helper with pipe delimiter and base64url output.
3. Test placeholder digests (`'d'.repeat(64)`) replaced with real computed values; authority.spec.ts digest assertions tightened to base64url format.

**Key work:**

- Create `packages/vote-engine/src/database/digest.ts` mirroring SQL Digest (join with `|`, SHA-256, base64url)
- Replace all 5 `Digest()` call sites in authority-engine.ts with local `digest()` helper
- Convert 2 pre-concatenated single-arg calls to multi-arg form (per D-04)
- Update test files: signing.spec.ts, elections.spec.ts, election.spec.ts, authority.spec.ts
- Full audit: no other engine computes digests (per D-10)

**Plans:** 3 plans

**Wave 1:**

- [x] 11-digest-unification/11-01-PLAN.md — Unified digest() helper + unit tests + JS-vs-SQL cross-verification -- **DONE 2026-05-26** (11 passing tests; 504/0/74 full suite)

**Wave 2** *(blocked on Wave 1 completion)*:

- [x] 11-digest-unification/11-02-PLAN.md — Authority-engine migration (5 call sites) + test placeholder replacement -- **DONE 2026-05-26** (5 call sites migrated, 16 placeholders replaced; 504/0/74 full suite)

**Wave 3** *(blocked on Wave 2 completion)*:

- [x] 11-digest-unification/11-03-PLAN.md — Verification (D-01..D-11 spot checks, full suite regression, codebase audit) -- **DONE 2026-05-26** (all 11 decisions PASS; 504/0/74 full suite; PHASE 11 CODE-COMPLETE)

---

### Phase 12: SQL-Side Digest Migration

**Goal:** Move all Cid/digest computation from the JS digest() helper into SQL Digest() expressions within INSERT statements, then remove packages/vote-engine/src/database/digest.ts entirely. The SQL Digest() function in initialize.ts becomes the single source of truth for all digest computation — no JS-side pre-computation. Additionally: remove the digest field from the Invite interface, split startSigningSession into generateSigningNonce + startSigningSession, reverse the invite flow insert ordering, update builders and mock engines.

**Depends on:** Phase 11 (Digest Unification).

**Requirements:** D-01..D-21 (CONTEXT.md decisions).

**Success Criteria:**

1. All INSERT statements that compute a Cid use the SQL `Digest()` function directly instead of receiving a pre-computed value from JS.
2. `packages/vote-engine/src/database/digest.ts` is deleted — no JS-side digest helper exists.
3. Full test suite passes with no regressions.

**Plans:** 4/4 plans complete

**Wave 1:**

- [ ] 12-sql-side-digest-migration/12-01-PLAN.md — Vote-core interface surgery (Invite digest removal, DigestArgs types, ISigningEngine update) + SigningEngine two-path implementation

**Wave 2** *(blocked on Wave 1; plans 02 and 03 run in parallel)*:

- [ ] 12-sql-side-digest-migration/12-02-PLAN.md — Authority-engine migration (digest removal, invite flow restructuring, SQL Digest in INSERTs) + network-engine CID readback
- [ ] 12-sql-side-digest-migration/12-03-PLAN.md — Builder updates (SigningStartSigningSessionBuilder digestArgs migration, KIND_VERSION bump) + MockSigningEngine deterministic behavior

**Wave 3** *(blocked on Wave 2 completion)*:

- [ ] 12-sql-side-digest-migration/12-04-PLAN.md — Test migration (remove digest imports, DB readback patterns) + delete digest.ts/digest.spec.ts + full verification

---

### Phase 12.1: Implement Skipped & Stub Tests (INSERTED)

**Goal:** Implement the test logic for all 82 `it.skip` stubs across the test suite. These tests were blocked on quereus#23 (now resolved in quereus 3.x) or awaited upstream engine work that has since landed. Even where a test still needs to remain skipped due to a residual blocker, write the full test body so the logic is ready to activate.

**Depends on:** Phase 12 (all engine + digest work finalized).

**Requirements:** Derived from v1.0 TEST-01..05 and v1.1 BTEST-01..03 — closes out the "pending" column.

**Scope by file:**

| File | Skipped | Category |
|------|---------|----------|
| network.spec.ts | 20 | Engine DB-bound + builder equivalence smokes |
| elections.spec.ts | 17 | Election lifecycle + builder equivalence |
| user.spec.ts | 13 | User builder real-engine + equivalence |
| election.spec.ts | 12 | Election builder real-engine + equivalence |
| authority.spec.ts | 7 | Authority builder equivalence smokes |
| networks.spec.ts | 6 | Networks builder real-engine + equivalence |
| tasks-builders.spec.ts | 4 | Tasks builder equivalence smokes |
| signing.spec.ts | 2 | Signing builder equivalence smokes |
| quereus-repros/stage-7-in-subquery.spec.ts | 1 | Quereus 3.x primary key() behavior |

**Success Criteria:**

1. Every `it.skip` stub has a complete test body with assertions (not just a description string).
2. Tests that can now pass with quereus 3.x are unskipped (`it.skip` → `it`).
3. Tests that still hit a genuine blocker retain `it.skip` with updated annotations explaining the specific remaining issue.
4. `yarn test` in `packages/vote-engine` passes with zero failures and the pending count is significantly reduced from 74.

**Key work:**

- Unskip and implement all quereus#23-blocked tests that are now unblocked by quereus 3.x
- Write full test bodies for empty `it.skip` stubs (builder equivalence smokes, real-engine DB roundtrips)
- Update skip annotations for any tests that remain blocked (document specific residual blocker)
- Verify the full suite passes with no regressions

**Plans:** 4/4 plans complete

**Wave 1:**

- [x] 12.1-implement-skipped-stub-tests/12.1-01-PLAN.md — Shared test helpers infrastructure (test-context.ts with composable layer functions) — COMPLETE 2026-05-27 (0af67c3)

**Wave 2** *(blocked on Wave 1 completion)*:

- [x] 12.1-implement-skipped-stub-tests/12.1-02-PLAN.md — Engine DB-bound tests: network.spec.ts (5 tests) + elections.spec.ts (11 lifecycle tests) — COMPLETE 2026-05-27

**Wave 3** *(blocked on Wave 2 completion)*:

- [x] 12.1-implement-skipped-stub-tests/12.1-03-PLAN.md — Builder real-engine triplets (~59 tests across 8 files) — COMPLETE 2026-05-27 (ec6ddee Task1, e21862c Task2); 517 passing / 48 pending / 0 failing

**Wave 4** *(blocked on Wave 3 completion)*:

- [x] 12.1-implement-skipped-stub-tests/12.1-04-PLAN.md — Quereus repro (A3 re-skipped, zero-column PK constraint) + D-06 annotation sweep + 6 tests unskipped — COMPLETE 2026-05-27 (3283cc4); 523 passing / 42 pending / 0 failing

### Phase 12.2: Extend Test Fixtures for E2E Seeding (INSERTED)

**Goal:** Extend test helpers to seed invite flow, signing pipeline, and election creation; unskip ~35 tests blocked by missing DB rows (not quereus upstream)
**Requirements**: TEST-01, TEST-03, TEST-05, BTEST-02
**Depends on:** Phase 12.1
**Plans:** 3 plans

**Success Criteria:**

1. `createTestNetwork()` succeeds under quereus 3.2.1 (AdminValid regression fixed via split-batch exec).
2. `addTestElection()` seeds the full signing pipeline and creates an Election row without error.
3. `seedAuthorityInvite()` creates InviteSlot + InviteResult rows via real engine methods.
4. ~35 previously-skipped tests are unskipped; test suite at >= 550 passing / <= 10 pending / 0 failing.

**Wave 1:**

- [x] 12.2-extend-test-fixtures-for-e2e-seeding/12.2-01-PLAN.md — Pin quereus 3.1.2, split-batch create()/createAuthority(), extend createAuthority() invite params, fix createElection() date format + signingNonce, export peekNextElectionTid()

**Wave 2** *(blocked on Wave 1 completion)*:

- [x] 12.2-extend-test-fixtures-for-e2e-seeding/12.2-02-PLAN.md — Composable test helpers: seedElectionSigning, addTestElection rewrite, seedAuthorityInvite, makeDistinctTestUser, makeTestSignature

**Wave 3** *(blocked on Wave 2 completion)*:

- [x] 12.2-extend-test-fixtures-for-e2e-seeding/12.2-03-PLAN.md — Unskip ~35 tests across 7 spec files (elections, election, network, authority, user, tasks-builders, signing) — COMPLETE 2026-05-27; canonical-datetime migration follow-up landed 2026-05-28 (91581df): 547 passing / 25 pending / 0 failing on quereus 3.2.1

---

### Phase 12.3: Close Non-Quereus Pending Tests (INSERTED)

**Goal:** Resolve the ~18 pending tests whose blockers are engine bugs, schema design, or test-infrastructure gaps. Quereus-upstream-only blockers (5 tests across Groups D + G) remain skipped pending upstream fixes.
**Requirements**: TEST-01, TEST-03, TEST-05, BTEST-02 (closure)
**Depends on:** Phase 12.2
**Plans:** 9 plans in 3 waves

**Success Criteria:**

1. `respondToInvite` Digest formula matches `Authority.InsertValid` expectation (6 network tests unblock).
2. `ProposedNetwork` schema accepts multiple proposed revisions (3 network revision tests unblock).
3. `User.InsertValid` second-user invite chain wired into test seeding (3 user builder tests unblock).
4. `ElectionEngine.addQuestion` / `addOption` callable from tests with proper Ballot seeding (2 elections tests unblock).
5. `OfficerSignature` PK self-call avoided in signing equivalence smoke (1 signing test unblock).
6. Raw-SQL tests that hardcode `Date.now()` / `'user-1'` rewritten to use canonical fixtures (3 authority/network tests unblock).
7. Test suite at >= 565 passing / <= 7 pending (D + G only) / 0 failing.

**Out of scope (waits for quereus upstream):**

- Group D — `Task.ExtensionExists` ↔ `*.TaskIdValid` circular CHECK dependency (4 tests)
- Group G — `primary key ()` zero-column PK UNIQUE enforcement (1 test)

---

*Roadmap last updated: 2026-05-28 — Phase 12.3 Wave 1 done (01/02/09 — respondToInvite SQL Digest + ProposedNetwork composite PK + signing.spec.ts:574 unskip). Wave 2 in progress: Plan 03 done (seedUserInvite + seedBallot helpers); 04/05/06 next. 549 passing / 24 pending / 0 failing.*
