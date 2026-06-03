# Patch: @optimystic/quereus-plugin-optimystic composite-PK point lookup

Status: VERIFIED on Android/Hermes (emulator-5554), 2026-06-03. NOT yet landed upstream.
Package: @optimystic/quereus-plugin-optimystic@0.13.5

## Bug
`OptimysticModule.query()` routes a primary-key equality seek (plan=2 / legacy idxNum===1)
to `executePointLookup(String(filterInfo.args[0]))` — using ONLY the first key column.
Rows are stored under the FULL composite key (PK parts joined with `\x00`, see
`row-codec.ts` extractPrimaryKey / createPrimaryKey). So for any table with a composite
primary key, a full-key equality lookup builds the wrong key and finds nothing — even
though the row exists (a partial/prefix query works because it falls back to a table scan).

Impact on VoteTorrent: every composite-PK existence CHECK in votetorrent.qsql fails on the
LevelDB vtab (e.g. Officer.AdminValid `exists(select 1 from Admin where AuthorityId=.. and
EffectiveAt=..)`), so NetworksEngine.create() aborts. In-memory Quereus is unaffected, which
is why all 594 vote-engine tests pass and never caught this.

## Fix (source: src/optimystic-module.ts, query() dispatch)
Build the composite key from ALL args via the same codec used at write time:

  } else if (planType === 2 && filterInfo.args.length > 0) {
-   yield* this.executePointLookup(String(filterInfo.args[0]));
+   yield* this.executePointLookup(filterInfo.args.length > 1
+     ? this.rowCodec.createPrimaryKey(filterInfo.args)
+     : String(filterInfo.args[0]));
  } else if (planType === 3) {
    ...
  } else if (filterInfo.idxNum === 1) {
-   yield* this.executePointLookup(filterInfo.args[0] ? String(filterInfo.args[0]) : "");
+   yield* this.executePointLookup(filterInfo.args.length > 1
+     ? this.rowCodec.createPrimaryKey(filterInfo.args)
+     : (filterInfo.args[0] ? String(filterInfo.args[0]) : ""));

Compiled equivalent currently applied locally at:
  node_modules/@optimystic/quereus-plugin-optimystic/dist/chunk-HPFDTDHY.js  (lines ~1487-1492)

## Proper landing options
1. Fix upstream in gotchoices/optimystic (packages/quereus-plugin-optimystic) and republish
   (preferred — @optimystic is the same org as VoteTorrent).
2. yarn patch @optimystic/quereus-plugin-optimystic and commit the generated .yarn/patches entry.

## Repro
apps/VoteTorrentAuthority/src/engines/persistence-proof-runner.ts runVtabCheckProbe()
probes A-H. Pre-fix: C/D FAIL, F full-composite-key read = undefined. Post-fix: all PASS.

---

# Second finding: re-attach requires re-declaring the schema (engine design)

Status: ROOT-CAUSED on-device, fix NOT yet landed (needs cross-backend reconciliation).

## Observation (probes T / T2, on-device)
Opening a SECOND Quereus Database handle on an existing Optimystic/LevelDB store does
NOT auto-restore the table catalog: `select ... from Network` → "Table 'Network' not
found in schema path: main", even though count(*) on the original handle is 1 and the
data is persisted. Re-running the schema DDL on the fresh handle makes the tables visible
AND preserves the rows (probe T2: Network count = 1 after re-declare — bind, not wipe).

## Impact
The Phase-14 locked design D-05/D-07 ("open() never runs DDL; re-attach is plugins-only")
is INVALID on the persistent backend. open() after a restart gets a fresh handle from
rnDbFactory and therefore sees NO tables → re-attach (PERSIST-02) and the read-after-restart
proof cannot work as designed. runWritePhase's second-handle count hit the same wall.

## Why it's not a one-liner
Quereus `declare schema main { ... }` is DECLARATIVE. Re-running it:
  - on the persistent vtab (fresh handle): binds persisted tables (works — probe T2).
  - on in-memory (handle already has the schema): triggers a declarative MIGRATION that
    fails ("Cannot DROP NOT NULL on PRIMARY KEY column 'DependsOn'").
So "always re-run DDL on re-attach" breaks the in-memory backend / the 594-test suite.

## Recommended fix design (next focused pass)
open() re-attach must re-declare the schema ONLY when this handle doesn't already have it:
  1. registerDbPlugins(db)
  2. detect whether domain tables are declared in THIS handle (e.g. try `select 1 from
     Network`); if declared (in-memory cache-miss mock) → skip re-declare.
  3. if NOT declared (persistent fresh handle) → re-run the domain DDL (binds data) +
     re-declare SchemaVersion/TidSequence so the marker/counter rebind.
  4. gate on the SchemaVersion marker (or "Network row exists") so a fresh/unknown store
     still THROWS (preserve D-05 intent: no fabricated empty network).
Then update the Phase-14 open() tests that assert "0 DDL calls on open" to the revised
contract (open re-declares idempotently; uninitialized store still throws; no re-insertion).

This overturns locked decisions D-05/D-07 with on-device evidence and should be planned as
its own change (engine + tests), not folded into the proof.
