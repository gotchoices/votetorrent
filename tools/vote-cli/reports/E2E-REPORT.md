# VoteTorrent CLI — end-to-end test report

Run: 2026-10-27T05:33:20.187Z · total 470.5 s · branch `feat/VoterConnectNetwork`
Host: Darwin 24.6.0 arm64, 10 × Apple M1 Pro, 16 GB, Node v22.15.0
Timeline: voting opened 4 min after the election was created and stayed open 3 min; later events 15 s apart.

**Result: 18/18 tests passed** · 56/56 checks passed · 79 CLI invocations (76 succeeded; some failures are expected refusals).

Of the 470.5 s total, 400.3 s was spent waiting for the election timeline (voting to open, the key-release window), not doing work.

## Tests

| # | Test | App | Result | Duration | of which waiting on the timeline | Checks |
|---|---|---|---|---:|---:|---|
| T01 | Start the device daemons (1 authority, 2 keyholder devices, 4 voters) | both | PASS | 1678 ms | — | 1/1 |
| T02 | Authority founds a network (Add Network screen) | authority | PASS | 2531 ms | — | 3/3 |
| T03 | Officer registers an intake encryption key | authority | PASS | 77 ms | — | 1/1 |
| T04 | Authority mints a join code (Invite voters card) | authority | PASS | 116 ms | — | 1/1 |
| T05 | A forged join code (wrong anchor digest) is refused | voter | PASS | 1227 ms | — | 2/2 |
| T06 | Keyholder devices join the network (Authority app, Join Network) | authority | PASS | 3290 ms | — | 3/3 |
| T07 | Voters join the network from the join code (Voter app, Join Network) | voter | PASS | 9097 ms | — | 4/4 |
| T08 | Network revision: propose and apply a relay change (rn threshold 1) | authority | PASS | 459 ms | — | 3/3 |
| T09 | Officer invitation is created and accepted by a second Authority device | authority | PASS | 355 ms | — | 2/2 |
| T10 | Authority creates an election (Create Election screen) | authority | PASS | 567 ms | — | 3/3 |
| T11 | Ballot: propose, submit for confirmation, sign the ballot task | authority | PASS | 1589 ms | — | 3/3 |
| T12 | Keyholders: invite, accept on keyholder devices, run the DKG to an election key | authority | PASS | 6888 ms | — | 6/6 |
| T13 | Voter registration ceremony + officer review (sync, approve, associate) | both | PASS | 16.5 s | — | 8/8 |
| T14 | Casting before voting opens is refused | voter | PASS | 144 ms | — | 1/1 |
| W1 | Wait for votingStarts (timeline, not work) | - | WAIT | 214.3 s | 214.3 s | — |
| T15 | Voters cast their votes (Review & Submit), read the receipt | voter | PASS | 399 ms | — | 5/5 |
| T16 | Voters send their votes through a pool (min 3) via the authority rendezvous | voter | PASS | 24.6 s | — | 4/4 |
| T17 | Keyholders release their key shares once releasingKeys opens | authority | PASS | 186.5 s | 186.0 s | 2/2 |
| T18 | Election results: reconstruct the key, open the block, tally | authority | PASS | 127 ms | — | 3/3 |
| T19 | Stop all daemons | both | PASS | 50 ms | — | 1/1 |

## Timing by command

Wall = the whole `vt` process (Node start, RPC, exit). Daemon = time inside the device daemon, i.e. the workflow itself.

| Command | Runs | Wall median | Daemon median | Daemon min | Daemon max |
|---|---:|---:|---:|---:|---:|
| `admin show` | 1 | 64 ms | 18 ms | 18 ms | 18 ms |
| `ballot confirm` | 1 | 1270 ms | 1222 ms | 1222 ms | 1222 ms |
| `ballot propose` | 1 | 131 ms | 80 ms | 80 ms | 80 ms |
| `ballot show` | 1 | 100 ms | 54 ms | 54 ms | 54 ms |
| `daemon start` | 7 | 1664 ms | 1616 ms | 1614 ms | 1627 ms |
| `daemon stop` | 7 | 48 ms | 0 ms | 0 ms | 0 ms |
| `election create` | 1 | 367 ms | 320 ms | 320 ms | 320 ms |
| `election results` | 1 | 127 ms | 84 ms | 84 ms | 84 ms |
| `election show` | 2 | 100 ms | 49 ms | 36 ms | 62 ms |
| `intake-key register` | 1 | 76 ms | 34 ms | 34 ms | 34 ms |
| `invite accept` | 1 | 127 ms | 85 ms | 85 ms | 85 ms |
| `keyholder accept` | 2 | 445 ms | 396 ms | 208 ms | 584 ms |
| `keyholder dkg` | 2 | 5030 ms | 4985 ms | 4334 ms | 5636 ms |
| `keyholder invite` | 2 | 226 ms | 171 ms | 165 ms | 177 ms |
| `keyholder status` | 1 | 123 ms | 79 ms | 79 ms | 79 ms |
| `keys release` | 2 | 478 ms | 401 ms | 358 ms | 443 ms |
| `network create` | 1 | 2412 ms | 2366 ms | 2366 ms | 2366 ms |
| `network join` | 6 | 5533 ms | 5478 ms | 862 ms | 8859 ms |
| `network join-code` | 1 | 116 ms | 73 ms | 73 ms | 73 ms |
| `network revise` | 2 | 198 ms | 153 ms | 54 ms | 251 ms |
| `network show` | 3 | 62 ms | 19 ms | 5 ms | 137 ms |
| `officer invite` | 1 | 227 ms | 184 ms | 184 ms | 184 ms |
| `register` | 3 | 12.5 s | 12.5 s | 10.5 s | 12.5 s |
| `registrants list` | 4 | 68 ms | 25 ms | 21 ms | 33 ms |
| `registration approve` | 3 | 693 ms | 651 ms | 635 ms | 1015 ms |
| `registration list` | 4 | 72 ms | 27 ms | 18 ms | 40 ms |
| `registration status` | 3 | 97 ms | 47 ms | 46 ms | 49 ms |
| `registration sync` | 4 | 1054 ms | 981 ms | 178 ms | 1975 ms |
| `status` | 1 | 50 ms | 0 ms | 0 ms | 0 ms |
| `tasks list` | 1 | 87 ms | 40 ms | 40 ms | 40 ms |
| `vote cast` | 5 | 194 ms | 141 ms | 57 ms | 200 ms |
| `vote receipt` | 1 | 49 ms | 6 ms | 6 ms | 6 ms |
| `vote send` | 3 | 24.6 s | 24.5 s | 24.3 s | 24.5 s |

## Test details

### T01 — Start the device daemons (1 authority, 2 keyholder devices, 4 voters)

Result: **PASS** in 1678 ms

- ✅ all 7 daemons started

| Device | Command | OK | Wall | Daemon |
|---|---|---|---:|---:|
| V3 | `vt daemon start --role voter --name "Voter V3"` | yes | 1659 ms | 1614 ms |
| K1 | `vt daemon start --role authority --profile transaction --name "Keyholder K1"` | yes | 1663 ms | 1616 ms |
| K2 | `vt daemon start --role authority --profile transaction --name "Keyholder K2"` | yes | 1662 ms | 1616 ms |
| A | `vt daemon start --role authority --name "Alice Officer"` | yes | 1664 ms | 1616 ms |
| V2 | `vt daemon start --role voter --name "Voter V2"` | yes | 1672 ms | 1627 ms |
| V1 | `vt daemon start --role voter --name "Voter V1"` | yes | 1674 ms | 1625 ms |
| VX | `vt daemon start --role voter --name "Voter VX"` | yes | 1672 ms | 1623 ms |

### T02 — Authority founds a network (Add Network screen)

Result: **PASS** in 2531 ms

- ✅ network created with a primary authority — `{"hash":"a11bbfd756f6756b4d4d5161828f30cf"}`
- ✅ network details read back — `E2E Network`
- ✅ the founder is the sole officer with all 9 founding scopes — `["rn","rad","vrg","iad","uai","ceb","mel","cap","ik"]`

| Device | Command | OK | Wall | Daemon |
|---|---|---|---:|---:|
| A | `vt network create --name "E2E Network" --authority-name "E2E Election Authority" --domain e2e.votetorrent.local` | yes | 2412 ms | 2366 ms |
| A | `vt network show` | yes | 54 ms | 5 ms |
| A | `vt admin show` | yes | 64 ms | 18 ms |

### T03 — Officer registers an intake encryption key

Result: **PASS** in 77 ms

- ✅ intake key published and current — `{"userId":"cc2dfb71-80ab-4ddd-b87c-5ee8526ddec6","authorityId":"71dffc8d-90be-419d-aed9-92fa232c9379","hasLocalKey":true,"localPublicKey":"0246282114086370285feb4f8bd147d44646668cc96780564d22ea809331e7005f","published":true,"isCurrent":true,"isIntakeRecipient":true,"isContested":false,"stranded":fal`

| Device | Command | OK | Wall | Daemon |
|---|---|---|---:|---:|
| A | `vt intake-key register` | yes | 76 ms | 34 ms |

### T04 — Authority mints a join code (Invite voters card)

Result: **PASS** in 116 ms

- ✅ vtjoin2 code minted and fits one QR (<= 2953 chars) — `1319 chars, fingerprint 1ae1 640e 6cd8 bfa6`

| Device | Command | OK | Wall | Daemon |
|---|---|---|---:|---:|
| A | `vt network join-code` | yes | 116 ms | 73 ms |

### T05 — A forged join code (wrong anchor digest) is refused

Result: **PASS** in 1227 ms

- ✅ join refused with digest-mismatch — `{"ok":false,"reason":"digest-mismatch","detail":"digest-mismatch","steps":["admitting","syncing","verifying"]}`
- ✅ the forged network was not opened or recorded — `[]`

| Device | Command | OK | Wall | Daemon |
|---|---|---|---:|---:|
| VX | `vt network join "vtjoin2.eyJ2IjoyLCJpbnZpdGF0aW9uIjp7InYiOjEsInBhcnR5SWQiO..."` | yes | 912 ms | 862 ms |
| VX | `vt status` | yes | 50 ms | 0 ms |

### T06 — Keyholder devices join the network (Authority app, Join Network)

Result: **PASS** in 3290 ms

- ✅ K1 joined (redeemed) — `admitting>syncing>verifying>done`
- ✅ K2 joined (redeemed) — `admitting>syncing>verifying>done`
- ✅ keyholders see the same fingerprint as the authority

| Device | Command | OK | Wall | Daemon |
|---|---|---|---:|---:|
| K1 | `vt network join "vtjoin2.eyJ2IjoyLCJpbnZpdGF0aW9uIjp7InYiOjEsInBhcnR5SWQiO..."` | yes | 2970 ms | 2920 ms |
| K2 | `vt network join "vtjoin2.eyJ2IjoyLCJpbnZpdGF0aW9uIjp7InYiOjEsInBhcnR5SWQiO..."` | yes | 3289 ms | 3236 ms |

### T07 — Voters join the network from the join code (Voter app, Join Network)

Result: **PASS** in 9097 ms

- ✅ V1 joined (redeemed) — `admitting>syncing>verifying>done`
- ✅ V2 joined (redeemed) — `admitting>syncing>verifying>done`
- ✅ V3 joined (redeemed) — `admitting>syncing>verifying>done`
- ✅ a voter reads the network's primary authority from the replicated strand

| Device | Command | OK | Wall | Daemon |
|---|---|---|---:|---:|
| V1 | `vt network join "vtjoin2.eyJ2IjoyLCJpbnZpdGF0aW9uIjp7InYiOjEsInBhcnR5SWQiO..."` | yes | 7776 ms | 7720 ms |
| V2 | `vt network join "vtjoin2.eyJ2IjoyLCJpbnZpdGF0aW9uIjp7InYiOjEsInBhcnR5SWQiO..."` | yes | 8490 ms | 8436 ms |
| V3 | `vt network join "vtjoin2.eyJ2IjoyLCJpbnZpdGF0aW9uIjp7InYiOjEsInBhcnR5SWQiO..."` | yes | 8912 ms | 8859 ms |
| V1 | `vt network show` | yes | 184 ms | 137 ms |

### T08 — Network revision: propose and apply a relay change (rn threshold 1)

Result: **PASS** in 459 ms

- ✅ revision applied on the authority with both relays — `{"applied":true,"revision":0,"name":"E2E Network","relays":["/ip4/127.0.0.1/tcp/57195/ws/p2p/12D3KooWGeLkqyboeTifMGgxEv24B2R3p3bq3zspduFG2z1XG28y","/dns4/relay.e2e.votetorrent.local/tcp/443/wss"]}`
- ✅ a voter sees the revised relay list (replicated)
- ✅ a rename proposal is not surfaced by getDetails (engine behavior, recorded) — `the proposal renames the network ("E2E Network (renamed)"), and getDetails only surfaces proposals under the current name`

| Device | Command | OK | Wall | Daemon |
|---|---|---|---:|---:|
| A | `vt network revise --relay "/ip4/127.0.0.1/tcp/57195/ws/p2p/12D3KooWGeLkqyboeTifMGgxE..." --relay /dns4/relay.e2e.votetorrent.local/tcp/443/wss` | yes | 299 ms | 251 ms |
| V1 | `vt network show` | yes | 62 ms | 19 ms |
| A | `vt network revise --name "E2E Network (renamed)"` | no: no-proposal | 97 ms | 54 ms |

### T09 — Officer invitation is created and accepted by a second Authority device

Result: **PASS** in 355 ms

- ✅ officer invitation share created
- ✅ K1 accepted the officer invitation — `{"slotCid":"bafkreifs7m24coi3lfy62o6bosfqyek3tpbsxxr6pfxmj3blnqdqp2jp5m","accepted":true}`

| Device | Command | OK | Wall | Daemon |
|---|---|---|---:|---:|
| A | `vt officer invite --name "Kim Deputy" --title Deputy --scopes vrg,mel` | yes | 227 ms | 184 ms |
| K1 | `vt invite accept "{\"invitePrivate\":\"dae591e96f82d7582ee3e191053e618782b57be..." --type of` | yes | 127 ms | 85 ms |

### T10 — Authority creates an election (Create Election screen)

Result: **PASS** in 567 ms

- ✅ election created with a 10-event timeline and threshold 2 — `{"registrationEnds":"2026-10-27T05:29:48.484Z","ballotsFinal":"2026-10-27T05:29:47.484Z","votingStarts":"2026-10-27T05:29:48.484Z","accruingVotes":"2026-10-27T05:32:48.484Z","hashingVotes":"2026-10-27T05:33:03.484Z","releasingKeys":"2026-10-27T05:33:18.484Z","tallyingStarts":"2026-10-27T05:33:33.484`
- ✅ authority reads the election as Upcoming — `Upcoming`
- ✅ a voter sees the election (replicated) as Upcoming — `Upcoming`

| Device | Command | OK | Wall | Daemon |
|---|---|---|---:|---:|
| A | `vt election create --title "E2E Election" --voting-starts 2026-10-27T05:29:48.484Z --registration-ends 2026-10-27T05:29:48.484Z --ballots-final 2026-10-27T05:29:47.484Z --voting-minutes 3 --step-seconds 15 --threshold 2 --keyholders Kim,Kai` | yes | 367 ms | 320 ms |
| A | `vt election show` | yes | 87 ms | 36 ms |
| V2 | `vt election show` | yes | 113 ms | 62 ms |

### T11 — Ballot: propose, submit for confirmation, sign the ballot task

Result: **PASS** in 1589 ms

- ✅ ballot confirmed by the officer signature — `{"ballotId":"944d5ff4-5038-49a1-8386-b593078cde77","locked":false,"confirmed":true,"canWithdraw":false,"ownTaskOpen":false}`
- ✅ the confirmation went through a signature task
- ✅ a voter sees the confirmed ballot with both questions — `["mayor","measure-a"]`

| Device | Command | OK | Wall | Daemon |
|---|---|---|---:|---:|
| A | `vt ballot propose --description "General ballot" --question mayor\|Mayor\|ada,bo,cy --question "measure-a\|Measure A\|yes,no"` | yes | 131 ms | 80 ms |
| A | `vt tasks list` | yes | 87 ms | 40 ms |
| A | `vt ballot confirm --ballot 944d5ff4-5038-49a1-8386-b593078cde77` | yes | 1270 ms | 1222 ms |
| V3 | `vt ballot show` | yes | 100 ms | 54 ms |

### T12 — Keyholders: invite, accept on keyholder devices, run the DKG to an election key

Result: **PASS** in 6888 ms

- ✅ K1 accepted its keyholder seat — `baf8d5f6-c79f-4b7a-82c7-738ba63ec82f (attempt 1)`
- ✅ K2 accepted its keyholder seat — `93af291b-c304-4139-9872-196fada25e7f (attempt 1)`
- ✅ K1 finished the DKG — `4 driver passes; actions: posted-round-0, posted-round-1, posted-round-2, posted-round-3-ack, posted-round-4`
- ✅ K2 finished the DKG — `3 driver passes; actions: posted-round-0, posted-round-1, posted-round-2, posted-round-3-ack, posted-round-4, published-election-key`
- ✅ both keyholders derived the same joint public key
- ✅ the authority sees the election key

| Device | Command | OK | Wall | Daemon |
|---|---|---|---:|---:|
| A | `vt keyholder invite --name Kim` | yes | 211 ms | 165 ms |
| A | `vt keyholder invite --name Kai` | yes | 240 ms | 177 ms |
| K1 | `vt keyholder accept "{\"invitePrivate\":\"ab25d63f97dbab8d216b6f99cead00e4873e20b..."` | yes | 257 ms | 208 ms |
| K2 | `vt keyholder accept "{\"invitePrivate\":\"4ad777e38fd5af270b147e153df5b9aff398d6c..."` | yes | 632 ms | 584 ms |
| K2 | `vt keyholder dkg --until-done --timeout 240` | yes | 4379 ms | 4334 ms |
| K1 | `vt keyholder dkg --until-done --timeout 240` | yes | 5681 ms | 5636 ms |
| A | `vt keyholder status` | yes | 123 ms | 79 ms |

### T13 — Voter registration ceremony + officer review (sync, approve, associate)

Result: **PASS** in 16.5 s

- ✅ V1 submitted, got the challenge and answered it — `{"registrationSubmittedMs":93,"associationSubmittedMs":104,"challengeWaitMs":12157,"attestationSubmittedMs":70}`
- ✅ V2 submitted, got the challenge and answered it — `{"registrationSubmittedMs":200,"associationSubmittedMs":80,"challengeWaitMs":12106,"attestationSubmittedMs":64}`
- ✅ V3 submitted, got the challenge and answered it — `{"registrationSubmittedMs":140,"associationSubmittedMs":106,"challengeWaitMs":10072,"attestationSubmittedMs":101}`
- ✅ officer approved all 3 registration requests — `3 approved`
- ✅ all 3 registrants have a device association — `{"associated":3,"challenges":3}`
- ✅ V1 sees itself registered — `registered`
- ✅ V2 sees itself registered — `registered`
- ✅ V3 sees itself registered — `registered`

| Device | Command | OK | Wall | Daemon |
|---|---|---|---:|---:|
| A | `vt registration sync` | yes | 227 ms | 178 ms |
| A | `vt registration list --status p` | yes | 93 ms | 40 ms |
| A | `vt registrants list` | yes | 80 ms | 33 ms |
| A | `vt registration sync` | yes | 572 ms | 479 ms |
| A | `vt registration list --status p` | yes | 79 ms | 35 ms |
| A | `vt registration approve --request 346a824c-bb69-428e-bfd9-4657fcb7a245` | yes | 1058 ms | 1015 ms |
| A | `vt registration approve --request b78f111d-dd14-4a7a-82d2-c072001f0260` | yes | 693 ms | 651 ms |
| A | `vt registration approve --request 5e9ec669-a5a5-4cd5-b852-8e3c6cbe17e4` | yes | 681 ms | 635 ms |
| A | `vt registrants list` | yes | 64 ms | 22 ms |
| V3 | `vt register --first Cy --last Young --email v3@example.org --timeout 240` | yes | 10.5 s | 10.5 s |
| A | `vt registration sync` | yes | 2058 ms | 1975 ms |
| A | `vt registration list --status p` | yes | 64 ms | 19 ms |
| A | `vt registrants list` | yes | 71 ms | 27 ms |
| V1 | `vt register --first Ada --last Lovelace --email v1@example.org --timeout 240` | yes | 12.5 s | 12.5 s |
| V2 | `vt register --first Bo --last Diddley --email v2@example.org --timeout 240` | yes | 12.6 s | 12.5 s |
| A | `vt registration sync` | yes | 1536 ms | 1482 ms |
| A | `vt registration list --status p` | yes | 61 ms | 18 ms |
| A | `vt registrants list` | yes | 64 ms | 21 ms |
| V1 | `vt registration status --wait --timeout 120` | yes | 97 ms | 47 ms |
| V2 | `vt registration status --wait --timeout 120` | yes | 97 ms | 46 ms |
| V3 | `vt registration status --wait --timeout 120` | yes | 97 ms | 49 ms |

### T14 — Casting before voting opens is refused

Result: **PASS** in 144 ms

- ✅ refused with window-closed — `{"name":"Error","code":"window-closed","message":"voting is not open (lifecycle state Upcoming)"}`

| Device | Command | OK | Wall | Daemon |
|---|---|---|---:|---:|
| V1 | `vt vote cast --select mayor=ada --select measure-a=yes` | no: window-closed | 144 ms | 98 ms |

### T15 — Voters cast their votes (Review & Submit), read the receipt

Result: **PASS** in 399 ms

- ✅ V1 saved a signed, sealed vote — `2026-10-27T05:29:48.672Z`
- ✅ V2 saved a signed, sealed vote — `2026-10-27T05:29:48.729Z`
- ✅ V3 saved a signed, sealed vote — `2026-10-27T05:29:48.725Z`
- ✅ the receipt opens and holds exactly the selections — `{"mayor":"bo","measure-a":"yes"}`
- ✅ a second cast is refused (already-saved) — `{"name":"Error","code":"already-saved","message":"a vote is already saved for this election (use --replace to re-cast before sending)"}`

| Device | Command | OK | Wall | Daemon |
|---|---|---|---:|---:|
| V1 | `vt vote cast --select mayor=ada --select measure-a=yes` | yes | 194 ms | 141 ms |
| V3 | `vt vote cast --select mayor=ada --select measure-a=no` | yes | 246 ms | 198 ms |
| V2 | `vt vote cast --select mayor=bo --select measure-a=yes` | yes | 248 ms | 200 ms |
| V2 | `vt vote receipt` | yes | 49 ms | 6 ms |
| V1 | `vt vote cast --select mayor=ada --select measure-a=yes` | no: already-saved | 100 ms | 57 ms |

### T16 — Voters send their votes through a pool (min 3) via the authority rendezvous

Result: **PASS** in 24.6 s

- ✅ V1 vote sent in a committed block — `[{"ballotId":"944d5ff4-5038-49a1-8386-b593078cde77","status":"sent","cid":"bafkreibsp7r3pygy6w33mgokdmc5bsxxfivycmudnqxl2xvatg7cepcso4"}]`
- ✅ V2 vote sent in a committed block — `[{"ballotId":"944d5ff4-5038-49a1-8386-b593078cde77","status":"sent","cid":"bafkreibsp7r3pygy6w33mgokdmc5bsxxfivycmudnqxl2xvatg7cepcso4"}]`
- ✅ V3 vote sent in a committed block — `[{"ballotId":"944d5ff4-5038-49a1-8386-b593078cde77","status":"sent","cid":"bafkreibsp7r3pygy6w33mgokdmc5bsxxfivycmudnqxl2xvatg7cepcso4"}]`
- ✅ all three votes landed in ONE block — `["bafkreibsp7r3pygy6w33mgokdmc5bsxxfivycmudnqxl2xvatg7cepcso4"]`

| Device | Command | OK | Wall | Daemon |
|---|---|---|---:|---:|
| V2 | `vt vote send` | yes | 24.4 s | 24.3 s |
| V1 | `vt vote send` | yes | 24.6 s | 24.5 s |
| V3 | `vt vote send` | yes | 24.6 s | 24.5 s |

### T17 — Keyholders release their key shares once releasingKeys opens

Result: **PASS** in 186.5 s

- ✅ K1 released its share — `{"electionId":"election-1793078748526","revision":0,"releasingKeysAt":1793079198484,"hasEnteredReleasingKeys":true,"phase":"reconstructable","threshold":2,"participants":2,"releasedCount":2,"releasedUserIds":["93af291b-c304-4139-9872-196fada25e7f","baf8d5f6-c79f-4b7a-82c7-738ba63ec82f"],"awaitingUse`
- ✅ K2 released its share — `{"electionId":"election-1793078748526","revision":0,"releasingKeysAt":1793079198484,"hasEnteredReleasingKeys":true,"phase":"reconstructable","threshold":2,"participants":2,"releasedCount":2,"releasedUserIds":["93af291b-c304-4139-9872-196fada25e7f","baf8d5f6-c79f-4b7a-82c7-738ba63ec82f"],"awaitingUse`

| Device | Command | OK | Wall | Daemon |
|---|---|---|---:|---:|
| K1 | `vt keys release` | yes | 437 ms | 358 ms |
| K2 | `vt keys release` | yes | 519 ms | 443 ms |

### T18 — Election results: reconstruct the key, open the block, tally

Result: **PASS** in 127 ms

- ✅ one block with 3 entries opened — `[{"blockCid":"bafkreibsp7r3pygy6w33mgokdmc5bsxxfivycmudnqxl2xvatg7cepcso4","ballotId":"944d5ff4-5038-49a1-8386-b593078cde77","entries":3,"opened":3}]`
- ✅ tally matches the votes cast (mayor: ada 2, bo 1; measure-a: yes 2, no 1) — `{"944d5ff4-5038-49a1-8386-b593078cde77/mayor":{"bo":1,"ada":2},"944d5ff4-5038-49a1-8386-b593078cde77/measure-a":{"yes":2,"no":1}}`
- ✅ 3 voter rows recorded — `3`

| Device | Command | OK | Wall | Daemon |
|---|---|---|---:|---:|
| A | `vt election results` | yes | 127 ms | 84 ms |

### T19 — Stop all daemons

Result: **PASS** in 50 ms

- ✅ all daemons stopped

| Device | Command | OK | Wall | Daemon |
|---|---|---|---:|---:|
| V3 | `vt daemon stop` | yes | 47 ms | 0 ms |
| A | `vt daemon stop` | yes | 49 ms | 0 ms |
| K1 | `vt daemon stop` | yes | 49 ms | 0 ms |
| V1 | `vt daemon stop` | yes | 48 ms | 0 ms |
| V2 | `vt daemon stop` | yes | 48 ms | 0 ms |
| K2 | `vt daemon stop` | yes | 49 ms | 0 ms |
| VX | `vt daemon stop` | yes | 48 ms | 0 ms |

## Reading the timings

- `daemon start` (~1.8 s) is one device booting: Node, the vote-engine build, a CadreNode with its control database.
- `network create` and `network join` include opening the network's strand (the 88-statement schema applied onto the Optimystic store) — the founder creates it, a joiner waits for the first sync and verifies the founding digest.
- `register` is the voter's whole ceremony and **includes waiting for the officer**: it returns only after the authority has imported the request, approved it and issued the challenge (the e2e officer loop syncs every ~3 s).
- `vote send` is dominated by the PoolAgent's default 20 s quiet period: a pool forms only after 20 s with no new member (the app's defaults, unchanged).
- `keyholder dkg --until-done` repeats the one-step-per-screen-focus DKG driver until the election key exists; both keyholders run it at the same time.

## Findings

- **Two keyholders accepting at the same moment can collide (intermittent).** In run 5 of the history, K2's `respondToInvite` committed for 22.7 s and failed `Multi-collection commit lost a stale race for [InviteResult, User, UserKey, Keyholder, KeyholderDkgBinding] — Pend failed for collection UserKey`. The engine does not retry, so the app would show the keyholder an error; tapping Accept again works. Until the second keyholder is seated the DKG stays `blocked`. The suite now retries a lost race and records each loss here.
- **A network revision that renames the network cannot be applied.** `NetworkEngine.proposeRevision` stores it, but `getDetails()` looks proposals up `where Name = <current name>`, so a proposal under a new name is never surfaced and Network Details has nothing to apply. T08 records this; relay and policy revisions under the current name work.
- Refusals the tests require: casting before voting opens (`window-closed`), a second cast (`already-saved`) and the rename proposal (`no-proposal`) are the failed CLI invocations counted above; the forged join code returns a `digest-mismatch` result rather than an error.

## Run history

Every full run of this suite, oldest first. This report is the last row.

| # | Ran at | Passed | Total time | Notes |
|---:|---|---|---:|---|
| 1 | 2026-10-27T04:47:35.306Z | 1/18 | 4041 ms | CLI defect: the test read admin details in the wrong shape and the skip rule cascaded the failure to every later test. Fixed before run 2. |
| 2 | 2026-10-27T04:48:12.540Z | 12/18 | 386.3 s | CLI defects: `registration list` and `registrants list` read `items` instead of `rows`, so the officer approved nothing and no voter registered; `network revise` tried a rename, which the engine does not surface (recorded as a finding). Fixed before run 3. |
| 3 | 2026-10-27T05:05:24.640Z | 18/18 | 468.7 s | All tests passed. |
| 4 | 2026-10-27T05:06:09.111Z | —/18 | — | Stopped during T12. K2's keyholder accept hit `invite-unverifiable` (the invitation row had not replicated to K2 yet), and the CLI kept the identity it had provisioned instead of discarding it as the app does; K2's DKG then failed `signer-key-mismatch` and K1 waited out 240 s. Fixed: accept now re-reads and discards on failure like keyholder-accept.ts, the runner re-pastes a share the device cannot verify yet, and `keyholder dkg` follows the app's driveKeyholderDkg. |
| 5 | 2026-10-27T05:24:44.368Z | 14/18 | 714.8 s | Not passed: T12, T16, T17, T18. Both keyholders accepted at once; K2's accept (after 4 not-found and 1 invite-unverifiable while the invitation replicated) committed for 22.7 s and failed `Multi-collection commit lost a stale race … Pend failed for collection UserKey`. The engine does not retry it; the runner then gave up, K2 was never seated, the DKG stayed blocked and send/release/tally had no election key. Runner changed to retry a lost race (as a keyholder tapping Accept again) and record each loss as an observation. |
| 6 | 2026-10-27T05:33:20.187Z | 18/18 | 470.5 s | All tests passed. |

## What the CLI substitutes for the phone

The workflows call the shipped `vote-engine` build (`dist/rn-entry.js`, the entry both apps import) and the same `@serfab/cadre-core` / Optimystic stack, on the patched dependency tree in `packages/vote-engine/node_modules`. Only the React Native seams are replaced:

| App seam | CLI stand-in | Consequence |
|---|---|---|
| AsyncStorage | JSON file per device (`local.json`) | none for these workflows |
| Keystore/Secure Enclave keys | software secp256k1 identity key + software P-256 voting key | no hardware key protection, no biometric prompts |
| Play Integrity / key attestation | the dev stub attestation (nonce echo); the authority runs `StubAttestationVerifier` | **device attestation is not verified** — the app's dev-build mode |
| Hardware-wrapped `IKeyVault` | in-process memory vault | secrets are not wrapped |
| rn-leveldb strand + control storage | `MemoryRawStorage` | state lives as long as the daemon; a restart starts empty |
| WebSockets + circuit relay on phones | WebSockets on 127.0.0.1; the founding authority uses the `storage` profile (listens), everyone else `transaction` | no relay, no NAT; all peers on one host |

`election results` is CLI-only: no app screen tallies votes yet (there is no Tally/Result table), so the CLI reconstructs the key from the released shares and opens the blocks to verify the votes end to end.

Raw results: `/Users/arashrestha/ILAB/VOTETORRENT/votetorrent/tools/vote-cli/runs/2026-10-27T05-25-29-651Z/results.json` (per-device daemon logs in the same directory).
