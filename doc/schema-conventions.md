# Schema conventions & open decisions

Cross-cutting conventions for `packages/vote-core/schema/votetorrent.qsql` and
decisions that affect many tables at once. Table-specific design lives in the
per-domain docs (`registration.md`, `administration.md`, `election.md`, …).

---

## OPEN DECISION — `Cid` columns are digests, not CIDs

**Status:** Unresolved · **Owner:** team · **Scope:** schema-wide (~29 `Cid`
columns, ~27 `Digest()` call sites as of 2026-06-05)

### The fact

Every `Cid` column in the schema is populated by the crypto plugin's `Digest()`:

```
Cid = Digest(field1, field2, …)  →  base64url( sha256( concat(field bytes) ) )
```

That is a **bare hash digest**, not an [IPFS CID](https://github.com/multiformats/cid).
An IPFS CIDv1 is self-describing:

```
CIDv1 = multibase( version ‖ multicodec(content-type) ‖ multihash )
                    multihash = hashFnCode ‖ digestLength ‖ digestBytes
```

Our value carries none of that framing — no version, no content codec, no
multihash prefix (not even the sha2-256 code `0x12` + length `0x20`). It is the
innermost `digestBytes`, base64url-encoded. The repo uses **no** `multiformats`
/ IPLD anywhere; the libp2p layer addresses peers, and optimystic addresses
**Block IDs in a hash space** (`doc/optimystic.md`) — but the schema's `Cid`
columns are not CIDs and would not match a CID any IPLD store computes for the
same bytes.

Consequence today: these are content *digests* used as content addresses. They
work as internal keys, but the name "Cid" implies an interoperability and
self-description they do not have. A bare digest also has **no algorithm
agility** — nothing in the value identifies sha2-256, so the hash function
cannot be migrated without ambiguity.

### The decision to make

| Option | What it means | Trade-off |
|---|---|---|
| **A. Rename to `Hash`/`Digest`** | Admit they're internal content hashes; drop the "CID" implication | Cheap, honest; but if optimystic Block IDs ever need to *be* CIDs, the seam reappears |
| **B. Make them real CIDs** | Wrap the digest in a multihash (+ CIDv1 framing) so they interop with a content-addressed store | Self-describing, upgrade-safe, IPLD-compatible; larger values, plugin work, schema regen |
| **C. Status quo, documented** | Keep `Cid` columns as bare digests; document the convention and the optimystic-Block-ID mapping explicitly | No code change; the naming/interop hazard persists, just signposted |

Recommendation leaning **A** for the MVP (rename to stop implying IPFS
compatibility) unless the optimystic Block ID addressing is expected to require
real CIDs at the schema boundary — in which case **B**, decided before more
signed records exist.

### Related canonicalization issue (same root cause)

Multi-field digests are **not injective**: distinct logical records can collide.
Wherever a commitment mixes adjacent **variable-length** fields (names, JSON,
the registration commitments in `registration.md`), the field boundary is
ambiguous. The original framing ("no separator or length prefix, so
`Digest('ab','c') == Digest('a','bc')`") is only partly right — it depends on
*which* of three implementations you mean (verified 2026-06-05):

| Implementation | Where | Pre-image | `Digest('ab','c')==Digest('a','bc')`? |
|---|---|---|---|
| `Digest(...)` SQL UDF — **the one the schema actually calls** | `packages/vote-engine/src/database/initialize.ts` | `args.join('\|')` then sha256 → base64url | **No** — `"ab\|c"` ≠ `"a\|bc"` |
| `Digest(...)` JS export | `@optimystic/quereus-plugin-crypto` `dist/index.js` | bare `concatBytes(...)` then sha256 | **Yes** — both hash `"abc"` |
| `digest(...)` SQL UDF | `@optimystic/quereus-plugin-crypto` `dist/plugin.js` | single data arg (extra args are `algorithm`/`encoding`) | n/a — not multi-field |

So the schema's `Digest()` is votetorrent's **own** function (registered after
the plugin in `prepareDb`, so it shadows the plugin), and it *does* use a `|`
separator — the literal collision above does not occur there. But a bare,
unescaped delimiter join is still not injection-safe. Confirmed collisions in
the SQL `Digest()`:

- **Delimiter injection** — `Digest('a|b','c') == Digest('a','b|c')` (both → `"a|b|c"`)
- **Null/empty conflation** — `Digest(null,'x') == Digest('','x')` (both → `"|x"`)
- **Arity not encoded** — `Digest('a','b','c') == Digest('a|b','c')`

Because `Digest()` produces `AdminSigning.Digest` (the *content hash to be
signed*), any of these is a signature-substitution surface.

**The canonicalization fix is ours; the CID work is optimystic's** (tracked as
two reports under
`.planning/quick/260605-002-digest-canonicalization-reports/issues/`):

1. **votetorrent (the actual bug)** — give our own `Digest()` an injective
   pre-image (length-prefix / frame each argument; distinguish null from empty;
   encode arity). This is self-contained: the plugin's `digest()` is a
   single-value hash and is correct as-is, so combining fields injectively is
   *our* responsibility, not optimystic's. Also resolve the registry-key shadow
   (our `Digest` and the plugin's `digest` both key to `digest/-1`).
2. **optimystic (additive feature requests)** — add a real **CID UDF**
   (multihash + CIDv1) so `Cid` columns can become Option B above instead of bare
   digests, and *optionally* a vetted canonical multi-field digest helper so
   downstreams don't each reinvent (unsafe) field framing. Neither is required to
   fix #1.

This is a **breaking change** to every digest output — it invalidates existing
digests, addresses, and signatures, so it must be versioned / coordinated with a
schema regen, not patched silently.
