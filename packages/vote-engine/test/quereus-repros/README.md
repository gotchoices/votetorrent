# Quereus 2.x bug reproductions

In-repo, minimal, self-contained reproductions of Quereus 2.x bugs surfaced
during the VoteTorrent engine-insert-path investigation (see
`.planning/phases/03-network-authority-signing-engines/03-05-SUMMARY.md`).

Each `*.spec.ts` file isolates one or more closely-related bugs and asserts
the **observed** behavior so the test passes against Quereus 2.9.0. Once
upstream ships a fix, the assertion will fail and the test should be
inverted (assert correct behavior) before re-running.

The repros run as part of the normal `yarn test` suite — they serve as
regression checks after each Quereus version bump.

## Index of bugs

The investigation produced FOUR distinct upstream bugs across three repro
files. Plan 03-05's framing of three stages (6, 7, 8) turned out to fold
stage 7 into two independent bugs once isolated.

| File | Bug | Sub-tests | Severity |
|------|-----|-----------|----------|
| `stage-6-check-on-delete.spec.ts` | Bug C — `check on delete (expr)` fires on INSERT (and other ops) | 2 | High — blocks 4 insert paths in production schema |
| `stage-7-in-subquery.spec.ts` | Bug A — VIEW with `union all` returns only the first row | A1–A3 | Critical — silent data loss; subsumes Plan 03-05 "stage 3" |
| `stage-7-in-subquery.spec.ts` | Bug B — `X not in (subquery)` in CHECK always evaluates as false | B1–B3 | High — schema cannot express negative-membership constraints |
| `stage-8-json-array-elements-text.spec.ts` | Bug D — `json_array_elements_text/1` is not registered | 1 | Medium — workaround via `json_each` |

The original Plan 03-05 stage 7 claim ("IN (subquery) misbehaves in CHECK")
is **refuted** by sub-test B3: IN-against-table works correctly in CHECK.
The IN-against-view failure Plan 03-05 saw is a downstream symptom of Bug A.

## Filing upstream

The user (on the Quereus core team) files each bug separately. Drafted
issue bodies below are copy-paste ready — each links to the corresponding
spec file in this directory at the commit that introduced the repro.

---

### Issue: `check on delete (expr)` fires on INSERT (and other ops)

**File:** `packages/vote-engine/test/quereus-repros/stage-6-check-on-delete.spec.ts`

**Summary**

A CHECK constraint declared with the `on delete` modifier — e.g.,
`constraint X check on delete (false)` — is evaluated against INSERT
rows, not just DELETE rows as the syntax declares.

**Reproduction**

```sql
declare schema main

{
    table T (
        Id int,
        primary key (),
        constraint NoDeleteEver check on delete (false)
    );
}

apply schema main;

insert into T (Id) values (1);
-- throws: ConstraintError: CHECK constraint failed: NoDeleteEver
```

**Expected:** INSERT succeeds; `(false)` is scoped to DELETE ops only.

**Observed (Quereus 2.9.0):** INSERT throws `ConstraintError: CHECK constraint failed: NoDeleteEver`.

**Root cause hypothesis**

The parser correctly captures `operations: ['delete']` in the AST
(dist/src/parser/parser.js:3261/3361). The schema manager converts to
bitmask `RowOpFlag.DELETE = 4`. The bug is downstream — INSERT-path
evaluation is not filtering by op mask. Likely candidates:
`shouldCheckConstraint` or its callers in the constraint-builder layer.

**Confirmation that the literal `false` is not special**

`constraint NoDeleteEither check on delete (1 = 0)` (semantically
identical) reproduces the same failure on INSERT, ruling out a special
case in the literal-false handling path.

**Impact**

In a downstream schema (VoteTorrent), this is used by 16 constraints
across the schema; 4 actively block primary insert paths.

---

### Issue: VIEW with `union all` returns only the first row

**File:** `packages/vote-engine/test/quereus-repros/stage-7-in-subquery.spec.ts` (sub-tests A1–A3)

**Summary**

A view defined as `select … union all select … union all select …`
returns only the **first leg** of the union when queried. The same
`union all` chain evaluated inline (not wrapped in a view) returns
every row as expected.

**Reproduction**

Control — inline `union all` chain returns 3 rows:

```sql
select 'r' as Code union all
select 'g' as Code union all
select 'b' as Code;
-- 3 rows: 'r', 'g', 'b'
```

Bug — same chain wrapped in a view returns 1 row:

```sql
declare schema main

{
    view V as
        select 'r' as Code, 'Red' as Name
        union all select 'g' as Code, 'Green' as Name
        union all select 'b' as Code, 'Blue' as Name;
}

apply schema main;

select Code from V;
-- expected: 'r', 'g', 'b'  (3 rows)
-- observed: 'r'             (1 row)
```

**Expected:** 3 rows.

**Observed (Quereus 2.9.0):** 1 row (only the first leg).

**Downstream impact**

CHECK constraints that reference such views appear to "work" only when
the inserted value happens to match the first row of the view. Constraint
forms like `check (Color in (select Code from V))` and
`check (exists (select 1 from V where V.Code = Color))` both reject any
value beyond the first view row.

This is the actual root cause of the failure originally catalogued as
"stage 3" (derived-column-alias view resolution at CHECK eval) in the
VoteTorrent investigation. The earlier schema rewrite from
`(values …) as X(Code, Name)` to explicit `select 'X' as Code` form did
not fix the problem; it changed the shape but left the row-loss intact.

---

### Issue: `X not in (subquery)` in CHECK always evaluates as false

**File:** `packages/vote-engine/test/quereus-repros/stage-7-in-subquery.spec.ts` (sub-tests B1–B3)

**Summary**

A CHECK constraint of the form `check (X not in (subquery))` rejects
every row, regardless of whether X actually appears in the subquery
results. The same expression evaluates correctly in a SELECT context.

**Reproduction**

Control — works correctly in SELECT:

```sql
select ('g' not in (select Code from Block)) as v;
-- where Block = {'r', 'y'}
-- result: { v: true }   (correct)
```

Bug — fails in CHECK:

```sql
declare schema main

{
    table Block ( Code text primary key );

    table T (
        Id int,
        Color text,
        primary key (),
        constraint NB check (Color not in (select Code from Block))
    );
}

apply schema main;

insert into Block (Code) values ('r');
insert into Block (Code) values ('y');

insert into T (Id, Color) values (1, 'g');
-- expected: succeeds ('g' is not in {r, y})
-- observed: ConstraintError: CHECK constraint failed: NB (not Color in (select Code from Block))
```

**Expected:** INSERT succeeds.

**Observed (Quereus 2.9.0):** `ConstraintError: CHECK constraint failed: NB (not Color in (select Code from Block))`.

**Root cause hint**

The error message rewrites the expression as `not Color in (...)` —
suggesting an early de-sugaring of `not in` into `not (in)`. If the
inner `in (subquery)` yields NULL/undefined inside CHECK (or for some
other reason isn't a clean boolean), the outer `not` produces NULL and
the CHECK fails.

The positive form `check (X in (subquery))` against a real table works
correctly (see sub-test B3), so the issue is specific to the `not in`
path or the boolean coercion of its result inside CHECK eval.

---

### Issue: `json_array_elements_text/1` is not registered

**File:** `packages/vote-engine/test/quereus-repros/stage-8-json-array-elements-text.spec.ts`

**Summary**

References to `json_array_elements_text(json)` throw "Function not found".
The function is a Postgres-ism imported into schema-author mental models
but not present in Quereus core.

**Reproduction**

```sql
select 1 from json_array_elements_text('["a","b"]') S(s);
-- throws: QuereusError: Function not found: json_array_elements_text/1
```

**Resolution options (for upstream discussion)**

1. **Register an alias** — expose `json_array_elements_text(X)` as a
   built-in equivalent to `json_each(X)` projecting the `value` column,
   to ease porting Postgres-flavored schemas.
2. **Document the canonical equivalent** — extend `docs/sql.md` with a
   "Postgres equivalents" section pointing `json_array_elements_text`
   at `json_each(X)`.
3. **No action** — leave it to schema authors to discover `json_each`.

**Confirmation that `json_each` exists**

`select value from json_each('["a","b","c"]')` returns the 3 expected
rows under Quereus 2.9.0, so the schema-side workaround (rewrite all
`from json_array_elements_text(X) S(s)` as `from json_each(X)` and
project `value`) is viable today.

---

## When upstream fixes ship

1. Run `yarn test --grep "Quereus repro"` against the new version.
2. Assertions on the buggy behavior will fail — that's the signal.
3. For each failed sub-test:
   - Invert the assertion to require correct behavior.
   - Remove the "BUG" annotation from the test name.
   - Bump any depending VoteTorrent schema workaround (e.g., re-enable
     `check on delete` constraints, sweep `not in` rewrites, restore
     `json_array_elements_text` in the schema if the alias was registered).
4. Document the upstream version in the test header.
