# repro — upstream Optimystic reproductions, and their regression gates

Originally the evidence for **"a block with one holder can never gain a second, so everything
written before a cohort reached three is permanently unreadable"** — filed upstream as
[Optimystic #15][15], closed 2026-08-30.

These files are now the **regression gate for the fix**, and they are GREEN on
`@optimystic/db-p2p@0.27.0`. Keep them green.

[15]: https://github.com/gotchoices/Optimystic/issues/15

## The fix they lock down

The obvious fix — adopt a sole claim once the cohort is big enough to have declined it — was
**rejected**, correctly: it restores state on one peer's unbacked word, which is exactly what the
corroboration floor exists to prevent. Upstream made the founding write *prove itself* instead:

| release | what landed |
|---|---|
| 0.25.0/0.25.1 | `cluster/certified-claims.ts` — a claim whose cohort commit proof the caller **verified** is marked `certified`, and a certified claim short-circuits the two-distinct-peer rule. |
| 0.27.0 | the missing producer: a second `buildBlockCommitProof` call site on `CoordinatorRepo.commit`'s **solo short-circuit**, which self-signs a one-peer proof. The founding write — the one block guaranteed to be singly held — finally carries what the hatch needs. Plus signer-count weighing, so a self-signed solo receipt cannot outrank a cohort that stayed together. |

So the variable was never really holder count. It was whether the block carries a proof — and
before 0.27.0 the one block guaranteed to be singly held was the one block that had none.

## The corroboration-deadlock artifacts (Optimystic #15, closed)

| file | what it is | needs |
|---|---|---|
| `corroboration-floor.test.mjs` | the selection rules in arithmetic alone — calls db-p2p's `selectQuorumRev` / `selectQuorumBlock` directly, no mesh, no crypto | nothing but the package |
| `single-holder-block.test.mjs` | the same rules end-to-end on db-p2p's own mesh harness, **no cadre-core**, no sockets | nothing but the package |
| `probe-holders.mjs` | the topology-level census the issue was found from — who holds the block, what cohort each node derives | cadre-core, ~40s |

```bash
npm install                          # from tools/multipeer-gate
node --test repro/*.test.mjs         # 26 tests, all green on 0.27.0
```

## The multi-tree tear artifacts (Optimystic #17 / #18, open)

Found by the n=4 on-device replication proof on 2026-09-03, filed the same day. Both issues carry
these files inline, so the copies here and the copies upstream must not drift apart.

| file | what it is | needs |
|---|---|---|
| `legacy-multi-tree-tear.test.mjs` | [#17][17] — a table and the tree enforcing **its own** unique constraint are separate entries in `commitDirtyTreesLegacy`'s sequential sweep, so a failed index sync persists the row without its index and cannot roll back. Exported plugin API only, no mesh | nothing but the package |
| `probe-rival-conflict.mjs` | [#18][18] — the trigger: `pending conflict: unresolved rival action(s)` exhausting the 10-retry budget (~30-34s per write on-device). **This probe does NOT reproduce it** — it stays green across 4 shapes, which is the point: it narrows where the cause is not | nothing but the package |

[17]: https://github.com/gotchoices/Optimystic/issues/17
[18]: https://github.com/gotchoices/Optimystic/issues/18

`probe-rival-conflict.mjs` is a probe, not a gate — it is excluded from the `*.test.mjs` glob on
purpose. A green run of it proves nothing about the product; it only records that the in-process
mesh does not exercise whatever the device does.

## Why a green run here means something

A gate that has never been red proves nothing, so both files are built to fail in **either**
direction of drift, and this was verified by running them against 0.25.1:

```
0.27.0   23 pass / 0 fail
0.25.1   20 pass / 3 fail
             not ok  a SINGLE-SIGNER certified claim does NOT outrank equal-rev corroboration
             not ok  a SOLO commit retains a commit proof
             not ok  a block founded by a SOLO cohort is readable once the deployment grows
```

The arms that must never go green for the wrong reason:

- **`the floor still binds …`** (3 arms) — an *uncertified* sole claim must keep being **declined**
  at every cohort view that could supply a second voter. These are the arms this file originally
  asserted the opposite of. If they fail, someone lowered the bar instead of routing around it.
- **`NEGATIVE control — the same block WITHOUT its proof is still declined`** — the original 0.24.2
  reproduction, kept alive on purpose. Same bytes, same rev, same holder count; only the proof
  removed. It must still be refused. Every other end-to-end arm would also go green if the floor
  were simply removed; this one would not.
- **`a SINGLE-SIGNER certified claim does NOT outrank equal-rev corroboration`** — the conservative
  half of 0.27.0's signer weighing, and the arm most likely to be lost by a refactor that treats
  every certified claim alike.

Every expectation was read off the shipped behaviour, not inferred from the docs.

## Dependency pinning — read this before bumping

`package.json` carries an **`overrides` block, and it is load-bearing.**
`@serfab/cadre-core@0.11.0` declares `@optimystic/db-p2p: ^0.24.0`, which `^0.27.0` does not
satisfy, so **npm nests a private, unfixed 0.24.2 under cadre-core** while the top level reads
0.27.0. The gate then runs genesis on the old code and reports the defect as unfixed — a
convincing false negative that cost real time to diagnose. Check after any install:

```bash
find node_modules -path '*@optimystic/db-p2p/package.json'   # must print exactly ONE path
```

The main repo is not exposed to this: its root `resolutions` already flatten every consumer to one
copy. This standalone gate has no such repo-wide mechanism, hence the explicit overrides.

`@quereus/*` is pinned to **4.17.1**, the version the repo ships (with a yarn patch npm cannot
apply). Letting npm float to stock 4.18.0 introduces a DDL failure unrelated to anything under
test — a second confound worth removing.

## probe-holders.mjs

Brings up a real cadre topology and reports, per node, whether it holds
`default/CadrePeer/index/_uniq_5` and what cohort it derives for it. This is how holder count was
established as the variable.

```bash
DRONES=3 PEERS=0 MESH=1 GENESIS_AT=1 node repro/probe-holders.mjs   # founding write, 1 holder
DRONES=3 PEERS=0 MESH=1 GENESIS_AT=2 node repro/probe-holders.mjs   # 2 holders
DRONES=3 PEERS=0 MESH=1 GENESIS_AT=3 node repro/probe-holders.mjs   # 3 holders
```

On 0.24.2 the first row failed enrolment on three of four nodes with `claimed-elsewhere`
(blocksHeld 18/6/0/0). On 0.27.0 all four enrol and derive cohort(4) (blocksHeld 20/19/13/15).

`GENESIS_AT=N` runs the founder's owner-genesis write once `N` nodes are up, which is what sets the
holder count; the party then grows to `DRONES`. `HOLD_MS=90000` re-reads every 10s to test for
self-repair.

`DRONES`/`PEERS`/`RELAYS`/`MESH` also reproduce the original n=4 relay-only topology (`RELAYS=2`)
this was found in — see `../README.md`.
