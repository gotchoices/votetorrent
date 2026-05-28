---
type: quick
slug: quereus-not-null-text-null-column
date: 2026-05-28
---

# Investigate quereus 3.2.1 `NOT NULL on ProposedQuestion.DependsOn` against 3.3.0

## Context

Phase 12.3-08 surfaced `NOT NULL constraint failed: ProposedQuestion.DependsOn`
when `ElectionEngine.addQuestion` inserted into ProposedQuestion. The
schema declares `DependsOn text null`, so the bug was attributed to a
quereus parser / null-binding issue against `text null` columns.

The project has since upgraded to quereus 3.3.0. Goal:

1. Reproduce the failing scenario against 3.3.0 with a minimal isolated
   probe.
2. Confirm whether the bug persists, narrow it to the smallest possible
   schema, and re-classify if needed.
3. Write a regression spec in `packages/vote-engine/test/quereus-repros/`
   following the existing `stage-*` pattern.
4. Draft an upstream issue write-up under `issues/` mirroring the prior
   bug-A/B/C/D format.
5. Update the `addQuestion` skip annotation in `elections.spec.ts` with
   the corrected diagnosis if the bug is mis-attributed.

## Out of scope

- Filing the upstream issue (user owns that step).
- Engine-layer workarounds for the bug (separate plan if pursued).
- Unskipping the `addOption` companion test — that one is blocked on a
  separate `seedQuestion` fixture issue, not on this bug.
