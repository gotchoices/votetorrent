# repro — Optimystic single-holder corroboration deadlock

Evidence for the upstream issue: **a block with one holder can never gain a second, so
everything written before a cohort reached three is permanently unreadable.**

Three artifacts, cheapest first. The first two are the ones to run.

| file | what it is | needs |
|---|---|---|
| `corroboration-floor.test.mjs` | the cliff in arithmetic alone — calls db-p2p's `selectQuorumRev` directly | nothing but the package |
| `single-holder-block.test.mjs` | end-to-end on db-p2p's own mesh harness, **no cadre-core**, no sockets | nothing but the package |
| `probe-holders.mjs` | the topology-level census the issue was found from — who holds the block, what cohort each node derives | cadre-core, ~40s |

```bash
npm install                          # from tools/multipeer-gate
node --test repro/*.test.mjs
```

Both test files are **RED against `@optimystic/db-p2p@0.24.2`** and each ships its own
control arm, so a green run is proof of a fix rather than proof of a broken assertion:

```
ok   CORROBORATION_FLOOR is 2
ok   one holder, cohort view of 2 — the claim is accepted        <- control: relaxed floor
not  one holder, cohort view of 3 — the claim is accepted        <- the defect
not  one holder, cohort view of 4 — the claim is accepted
not  one holder, cohort view of 9 — the claim is accepted
not  a block with ONE holder is readable by another cohort member <- the defect, end to end
ok   control — the SAME block with TWO holders is readable        <- control: same code, 2 holders
```

## probe-holders.mjs

Brings up a real cadre topology and reports, per node, whether it holds
`default/CadrePeer/index/_uniq_5` and what cohort it derives for it. This is how the
holder count was established as the variable.

```bash
DRONES=3 PEERS=0 MESH=1 GENESIS_AT=1 node repro/probe-holders.mjs   # 1 holder  -> reads FAIL
DRONES=3 PEERS=0 MESH=1 GENESIS_AT=2 node repro/probe-holders.mjs   # 2 holders -> reads pass
DRONES=3 PEERS=0 MESH=1 GENESIS_AT=3 node repro/probe-holders.mjs   # 3 holders -> reads pass
```

`GENESIS_AT=N` runs the founder's owner-genesis write once `N` nodes are up, which is what
sets the holder count; the party then grows to `DRONES`. `HOLD_MS=90000` re-reads every 10s
to test for self-repair (there is none).

`DRONES`/`PEERS`/`RELAYS`/`MESH` also reproduce the original n=4 relay-only topology
(`RELAYS=2`) this was found in — see `../README.md`.
