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
