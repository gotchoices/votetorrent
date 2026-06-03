---
type: quick
slug: quereus-not-null-text-null-column
date: 2026-05-28
status: complete
---

# Summary

## Outcome

The Phase 12.3-08 diagnosis was **incorrect**. The bug is not on
`text null` columns; binding null to `text null` works on every path
(omitted from column list / SQL `null` literal / `:param` null). The
real bug is on columns declared with a non-NULL `default`:

> Binding explicit NULL — via `:param` or SQL `null` literal — to a
> column declared `<type> default <value>` raises
> `NOT NULL constraint failed: <table>.<column>`, even though the column
> is not declared `not null`. Omitting the column from the INSERT column
> list correctly applies the default.

ProposedQuestion has two affected columns: `OptionRange text default '{1, 1}'`
and `Required boolean default true`. `ElectionEngine.addQuestion` binds null
to both. The thrown error message names a nullable sibling (`DependsOn`)
rather than the offending default-bearing column, which is what produced
the original misdiagnosis.

## Artifacts

| File | Purpose |
|------|---------|
| `packages/vote-engine/test/quereus-repros/text-null-column.spec.ts` | In-repo regression: D1–D3 pin the broken behavior; D4–D6 pin the working contrast cases. |
| `issues/default-column-rejects-explicit-null.md` | Copy-paste-ready upstream issue write-up — minimal repro, misleading-column-name case, expected vs observed behavior, workarounds. |
| `packages/vote-engine/test/elections.spec.ts:449` | Skip annotation rewritten with the corrected diagnosis (was "quereus 3.2.1 raises NOT NULL on DependsOn"). |

## Investigation path

1. Initial probe (`text null` only): all paths worked → original
   diagnosis suspect.
2. Faithful repro of `ProposedQuestion` shape: bug surfaced, but error
   named `DependsOn`. Stripped column list: bug persisted on a
   `text default 'X'` column even alone.
3. Narrowed to "explicit null vs default" — confirmed across `:param`
   and SQL literal paths. Confirmed working when the column is omitted
   from the INSERT.
4. Reproduced the misleading-error-column case: 3-column schema
   `(A text null, Mid text default 'X', B text null)` binding null to
   all three throws `NOT NULL constraint failed: Q.A` (not `Q.Mid`).

## Bonus observations (not bugs, pinned in repro)

- In Quereus 3.3.0 a column declared as bare `<type>` (no `null` / `not null`
  keyword) is treated as NOT NULL — contrasts with SQLite/Postgres
  conventions. Pinned as D6 control in the repro.
- `default X` semantics for an omitted column work correctly (D4).

## Follow-up (NOT done in this task)

- File the issue upstream (user-owned).
- Decide whether to add an engine-layer workaround for `addQuestion` —
  either drop the schema-side defaults and apply them in JS, or build the
  column list dynamically based on whether the caller passed a value.
  Skipped test remains skipped with a precise annotation until that
  decision is made.
