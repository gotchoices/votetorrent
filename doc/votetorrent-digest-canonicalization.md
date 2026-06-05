# `Digest()` SQL UDF is not injection-safe, and shadows the optimystic crypto plugin

**Repo:** `votetorrent`
**Component:** `@votetorrent/vote-engine`
**Source:** `packages/vote-engine/src/database/initialize.ts` (`registerCustomFunctions` → `Digest`)
**Severity:** High — `Digest()` produces `AdminSigning.Digest`, the content hash that admin/officer signatures are taken over; colliding inputs are a signature-substitution surface.
**Verified:** 2026-06-05

## Summary

VoteTorrent registers its own variadic SQL `Digest(...)` that joins the
stringified arguments with a single `|` and hashes the result:

```ts
// packages/vote-engine/src/database/initialize.ts
const digestSchema = createScalarFunction(
  { name: 'Digest', numArgs: -1, flags: FunctionFlags.DETERMINISTIC, /* … */ },
  (...args: SqlValue[]) => {
    const parts = args.map(a => a === null || a === undefined ? '' : String(a));
    const concat = parts.join('|');
    return createHash('sha256').update(concat).digest('base64url');
  }
);
db.registerFunction(digestSchema);
```

This function is registered in `prepareDb` **after** `registerPlugin(db,
cryptoPlugin)`, so it **shadows** the optimystic crypto plugin — every
`Digest(...)` call in `votetorrent.qsql` resolves to *this* implementation, not
the plugin's.

Two problems:

### 1. The pipe-join is not injection-safe (correctness / security)

A bare, unescaped delimiter join is not injective. Distinct argument tuples
collide whenever a value contains the delimiter, an argument is null, or
adjacent arguments can be repartitioned. Confirmed against the registered
function:

```js
Digest('a|b', 'c')  === Digest('a', 'b|c');    // true  → "a|b|c"  (delimiter injection)
Digest(null, 'x')   === Digest('', 'x');        // true  → "|x"     (null/empty conflation)
Digest('a','b','c') === Digest('a|b', 'c');      // true  → "a|b|c"  (arity not encoded)
```

`AdminSigning.Digest` is documented in the schema as *"Content hash to be
signed"* and is compared throughout `votetorrent.qsql` against inline
`Digest(...)` calls over admin/officer/policy fields (e.g.
`Digest(EffectiveAt, ThresholdPolicies)`,
`Digest(AdminEffectiveAt, UserId, Title, Scopes)`). A collision means a
signature collected over field tuple X also verifies for a different tuple Y —
defeating the integrity guarantee. Any field that can contain `|`, or whose
null-vs-empty state an attacker controls, is exploitable.

> ### Note on the original report
> Reported as *"`Digest(a,b,c)` concatenates arg bytes with no separator or
> length prefix, so `Digest('ab','c') == Digest('a','bc')`."* That exact
> example does **not** hold for this SQL function — the `|` separator makes
> `"ab|c"` ≠ `"a|bc"`. (It *is* literally true of the optimystic plugin's JS
> `Digest` export — see the companion optimystic report.) The underlying
> concern, distinct inputs → identical digest, is real here via delimiter
> injection.

### 2. It shadows / diverges from the optimystic plugin (architecture)

VoteTorrent depends on `@optimystic/quereus-plugin-crypto` for `SignatureValid`
and registers the plugin in `prepareDb`, but then overrides `Digest` with a
local copy. The three digest implementations in play disagree on framing:

| Implementation | Pre-image |
|---|---|
| votetorrent SQL `Digest` (this issue) | `args.join('\|')` |
| plugin JS `Digest` export (`index.js`) | bare `concatBytes` (no separator) |
| plugin SQL `digest` (`plugin.js`) | single data arg only |

Maintaining a private hash format that silently shadows the dependency is a
divergence hazard: a plugin upgrade that adds a SQL `Digest` would change
behavior depending on registration order, and the local formula can drift from
the canonical one.

## Whose responsibility this is

The fix is **entirely on the VoteTorrent side**. Canonical, injective framing of
multiple logical fields is the caller's job as the crypto plugin's `digest()` is a
single-value hash and is correct as-is; "concatenate then hash" being
non-injective is a property of concatenation, not a plugin defect. So this issue
is about how VoteTorrent's own `Digest()` frames its fields, not about anything
optimystic must change. (The companion optimystic report asks only for additive
conveniences: a CID UDF, and optionally a vetted multi-field helper — neither of
which is required to fix this.)

## Expected behavior

- `Digest(x₁,…,xₙ)` is an injective encoding of the ordered, typed argument
  tuple: distinct tuples → distinct pre-images (length-prefix / escape /
  structured framing; null distinguishable from empty; arity encoded).
- VoteTorrent does not silently shadow the plugin's `digest` on the same
  registry key with diverging semantics (see below).

## Observed behavior

Collisions as above; local `Digest` shadows the plugin.

## Suggested resolution

1. Replace the pipe-join with a length-prefixed / framed pre-image (sketch
   below) so every existing call site stops colliding. This is self-contained
   and needs no upstream change.
2. Decide the shadowing explicitly (see note): either keep an
   intentionally-named VoteTorrent function, or build on the plugin's
   single-value `digest()` by hashing a caller-framed blob. If optimystic later
   ships the optional canonical multi-field helper (companion report), VoteTorrent
   can adopt it then — but that is not a prerequisite.

```ts
(...args: SqlValue[]) => {
  const h = createHash('sha256');
  for (const a of args) {
    if (a === null || a === undefined) { h.update(Buffer.from([0])); continue; }
    const buf = Buffer.from(String(a), 'utf8');
    const len = Buffer.alloc(4); len.writeUInt32BE(buf.length);
    h.update(Buffer.from([1])); h.update(len); h.update(buf);
  }
  return h.digest('base64url');
};
```

**Breaking-change caveat:** any change to the pre-image changes every digest.
The SQL `Digest()`, the TS-side digest/signing formulas in
`authority-engine.ts` (the D-05 path, which today bare-`+`-concatenates fields
for signing), and any persisted `Digest`/`Cid` values + signatures must move to
the new framing together, versioned with a schema regen — not patched silently.

## Standalone reproduction

`packages/vote-engine/test/digest-collision.spec.ts` (mocha + chai) exercises
the registered SQL `Digest()` via `prepareDb`. B1–B3 assert the collisions
(green = bug present); C1–C2 are controls, incl. one that refutes the literal
"no separator" framing. Invert B1–B3 to `.not.equal` once fixed.

## Related

- Companion optimystic report: `optimystic-digest-and-cid-udf.md`
- `doc/schema-conventions.md` — "Cid columns are digests, not CIDs" + the
  canonicalization sub-section.
