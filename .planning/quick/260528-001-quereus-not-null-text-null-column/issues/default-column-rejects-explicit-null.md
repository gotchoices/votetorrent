# Explicit NULL binding against a `default X` column throws `NOT NULL constraint failed`

**Affected versions:** confirmed in **3.3.0** (current latest); also reproduced in 3.1.2.

## Summary

A column declared with a non-NULL `default` value (e.g. `text default 'X'`,
`boolean default true`) treats an **explicit NULL binding** — via `:param`
or a SQL `null` literal — as a NOT NULL constraint violation. Omitting the
column from the INSERT column list correctly applies the default; only
**explicitly writing null** fails. The schema does not declare the column
as `not null`.

Worse, when the explicit-null happens to be in the same row as one or more
nullable sibling columns also bound to null, the thrown
`NOT NULL constraint failed` error can name an unrelated sibling column,
which makes the bug hard to diagnose. (We initially misread this as a bug
on `text null` columns; it is not — see the control case below.)

## Reproduction

### Minimal — single column

```js
import { Database } from '@quereus/quereus';

const db = new Database();
await db.exec(`
  declare schema main
  {
    table Q (
      Id text primary key,
      Mid text default 'X'
    );
  }
  apply schema main;
`);

// (a) via bound :param
await db.exec(`insert into Q (Id, Mid) values (:id, :mid)`,
  { id: '1', mid: null });
// → ConstraintError: NOT NULL constraint failed: Q.Mid

// (b) via SQL null literal
await db.exec(`insert into Q (Id, Mid) values ('1', null)`);
// → ConstraintError: NOT NULL constraint failed: Q.Mid

// (c) omitting the column — WORKS, default applies
await db.exec(`insert into Q (Id) values ('1')`);
// → ok; Mid = 'X'
```

### Misleading error column — the case that originally bit us

```js
const db = new Database();
await db.exec(`
  declare schema main
  {
    table Q (
      Id text primary key,
      A text null,
      Mid text default 'X',
      B text null
    );
  }
  apply schema main;
`);

await db.exec(
  `insert into Q (Id, A, Mid, B) values (:id, :a, :mid, :b)`,
  { id: '1', a: null, mid: null, b: null }
);
// → ConstraintError: NOT NULL constraint failed: Q.A
//   (the actual offending column is Q.Mid; Q.A is `text null` and the
//    binding is null, which is legal — but the error names it anyway.)
```

### Control — `text null` accepts null on every path

```js
await db.exec(`
  declare schema main
  {
    table Q (
      Id text primary key,
      A text null
    );
  }
  apply schema main;
`);

await db.exec(`insert into Q (Id) values ('omit')`);                    // ok
await db.exec(`insert into Q (Id, A) values ('lit', null)`);            // ok
await db.exec(`insert into Q (Id, A) values (:id, :a)`,
  { id: 'param', a: null });                                            // ok
```

## Expected behavior

Binding explicit NULL to a column declared with a `default` value (and
without `not null`) should be accepted — the bound null wins over the
default. This matches SQLite and PostgreSQL semantics: `INSERT ... VALUES
(NULL)` against a column with a default stores NULL.

The error message should also name the actual offending column, not an
unrelated sibling.

## Observed behavior

`ConstraintError: NOT NULL constraint failed: <table>.<column>` is thrown.
The named column may be a nullable sibling (also bound to null in the same
row), not the default-bearing column whose explicit-null binding actually
triggered the failure.

## Workarounds

1. Omit the column from the INSERT column list whenever you want the
   default. Build the column list and value list dynamically based on
   whether the caller provided a non-null value.
2. Drop the `default` from the column declaration and apply the default
   in application code before binding. This loses the schema-as-source-of-truth
   benefit but is the simplest fix at the engine layer.

Both workarounds were considered for VoteTorrent's `ElectionEngine.addQuestion`
(which binds null to `ProposedQuestion.OptionRange` / `Required`); the test
that exercises this path remains skipped with a precise annotation pending
an upstream fix.

## Standalone reproduction file

See the attached / linked `default-column-rejects-explicit-null.spec.ts`
(mocha + chai, drops in next to existing Quereus repros). Sub-tests
D1, D2, D3 reproduce the bug; D4, D5, D6 pin the working contrast cases.
The spec currently passes by asserting the **observed** broken behavior;
invert the assertions once a fix ships.
