# VoteTorrent: how it works and where it stands (updated 3 Nov 2026)

First written 2 Nov at 16:23 NPT on `3f5e192e`. Updated 3 Nov at about 17:15 NPT.

Branch `feat/VoterConnectNetwork` at `11b43832`, 8 commits past `3f5e192e`. One more commit, `77149965`, sits on `chore/lean-rig-in-repo` and is not merged. `.planning` is at `61800924`, 50 commits past `8f969bb4`.

Sources: a read-only trace of the code, the `.planning` records, git history from 2 Oct to 3 Nov 2026, and the device-run notes and logs. Section 0 is new. The other sections keep the 2 Nov text, with the facts that have changed since corrected in place.

---

## 0. What changed since 2 Nov 16:20

### Summary

The merge from 2 Nov passed its device test on emulators. Phase 65's device checks are all done, and the two problems it found (the second-network join hang and the iOS fresh-install break) have fixes. The Public page now runs on `node.reactivityWatch`, and its browser test connects for the first time. A keyholder now gets 4 biometric prompts per election instead of 17 (measured on the host), and a three-phone run is checking that on real phones right now. A new phase, 66, will make the officer dashboard live, and its plans are being written.

### New code (9 commits)

| Commit | What it does | Proven how far |
|---|---|---|
| `3443b5c9` | Fixes the iOS fresh-install break (F4). Two database providers shared one native LevelDB handle, and the pool closed it under the other. Each opener now gets a lease, and the handle closes when the last one closes. | iPhone: 4 clean starts, one of them a fresh install |
| `e81c9736` | Quick fix for the second-network join hang (F1). Both apps use one party id, `votetorrent`, so a phone already in authority A's group could never join authority B's. The join now stops at its 120 s budget, and a phone in another authority's group gets a clear refusal (`other-cadre`) in English and Spanish. | Host only (Node peers). Not checked on a phone. The real fix is deferred, as you chose |
| `a73b6f78` | Moves the Public page to `node.reactivityWatch`. One watch per public table replaces the hand-built subscription and its renewal timer. Two more fixes: the page node now uses the strand's network name (`strand-<id>`, not the bare hash, so it matched no node before), and collection ids are computed, so a table with no rows no longer fails boot. | Harness on two real strand nodes passes |
| `6f94bcda` | Lets the browser test connect. libp2p's browser build refuses to dial `localhost` and private IPs, so the browser gate could never have connected in any earlier run. A test-only host alias gets past it. | Browser gate 6 of 10 steps, the furthest yet (was 4) |
| `6cffa26c` | Stops strands counting the Public page as storage. Strand nodes put the anonymous page into their storage groups, which broke most of its watch registrations. The page now withdraws its storage services at start. | Harness 3 of 3: a write on one node reaches the page in about 0.5 s, with nothing stored on the page |
| `bcbf1902` | Cuts keyholder prompts from 17 to 4. Each keyholder seat gets one key, and each step (accept, each key-generation round, release) unlocks it at most once. The seat key is sealed to a new hardware key pair (Android Keystore RSA, iOS Secure Enclave), so accepting a seat costs no prompt. | Host: 0 + 1 + 1 + 1 + 1 = 4. Needs a new app binary; an old binary falls back to 5. Seats accepted before this change keep 17 |
| `967acbf4` | Repairs the host election driver, which `bcbf1902` broke: a keyholder module pulled in native code under plain Node. A guard test now fails if that import comes back. | Host driver self-check 21 of 21 |
| `11b43832` | `scripts/seed-election.sh`: sets up an all-host election up to a stage you pick (network, election, keyholders, key generation, voters, or full) and keeps the host peers running, so you can finish by hand on phones. | Network and key-generation stages tried; voters and full not yet |
| `77149965` | Moves the host election driver into the repo as `tools/lean-rig`, with no paths outside the repo. Separate branch, not merged. | Static checks only; no run yet |

### Device tests since 2 Nov

- The merge test of `3f5e192e` ran on emulators on 2 Nov, 16:23-18:22 NPT. D1-D5 passed:
  - an existing network opened after the upgrade, on Android and iOS;
  - Results screens re-read by themselves, in about 8 s after a key release and 4.5 s after a publish;
  - with matchmaking refused, the rendezvous formed the pool in about 8 s;
  - a keyholder-only device sees no Publish button, and a second publish returns `already-published`.
  - D6 (cost) was measured on the emulator Authority, not on the Redmi: median 107-120% of one core and about 1.03 GB of memory, with no figure from before the merge to compare with.
- In Phase 65 Run 8 (iPhone, 2 Nov evening) the Spanish copy check passed, so all six device gaps are now closed on Android and iPhone.
- A three-phone keyholder run started on 3 Nov and is still going. It uses two phone keyholders and one phone voter, with host peers, over the inspiringlab relay.
  - The first attempt (`kh2-phone1`) got through election setup and both seat accepts, then stalled in key generation. The host officer couldn't publish its address record for about 35 minutes ("peers-unreachable"), and the run was stopped at 16:58.
  - The second attempt (`kh2-iphone1`) has passed key generation, and its three host voters joined and staged by 17:13. It is still going.
  - Prompt counts read on the phones so far match the host numbers: accepting a seat cost 0 prompts on both the iPhone and the Android phone, and key generation cost 3 Face ID prompts on the iPhone. The release step is still to come.

### Planning since 2 Nov

- Phase 66, a live officer dashboard, was added on 3 Nov at your request. The dashboard becomes the officer's own network device in the browser and shows live data from the strand, in place of today's snapshot and Refresh button.
  - Decisions D-01 to D-28 are recorded. Every officer pairs their own browser through a single-use invitation that an online owner phone mints. The browser key is a wrapped raw seed, because a non-extractable WebCrypto key can't drive libp2p. A new table records revoked pairings.
  - Research, the validation plan and the UI design contract are done (the UI contract approved after one revision).
  - The outline has 27 plans in 10 waves. 20 were written by 17:06 today. No code yet.
- Phase 65's verification now waits on one host check (the spike-102 run with 5 voters), which needs a quiet host.

### Not committed yet

- `maestro/`: a shared set of Maestro UI tests for both apps (11 Voter, 8 Authority and 9 cross-device flows, plus a runner). All of them pass the syntax check. None has run on a device yet.
- The Voter tab bar got test ids, and the Voter got a `test:maestro` script.
- The browser mesh-read gate got an opt-in diagnostic mode (`MESH_READ_DIAG=1`).
- Both `bootstrap.config.json` files point at the inspiringlab relay.

---

## 1. What happens after a network is created

### What the officer and voter see

1. Add Network: the officer enters a name, authority, admin and at least one relay. Bad input is refused before any biometric prompt.
2. On the first create after a fresh install, the app sends the officer to set up a signing key, and the officer then taps Create again.
3. The screen shows "Creating…". After 45 s it checks whether the network landed anyway, and shows a neutral "still finishing" note rather than a false failure.
4. A recovery-key ceremony runs. The network home then opens with Elections, Tasks, Authorities and Settings.
5. To invite voters, the officer gets a join-code QR and a fingerprint to publish on an official channel. Other officers, authorities and keyholders join by invitation.
6. The voter goes to Join a network and scans or pastes the code. They check the name and fingerprint and watch it go from admitting to syncing to verifying to done. Then they register, link the device with Face ID or a fingerprint, and wait for the officer to approve.

### What the code does

| # | What happens | Where |
|---|---|---|
| 1 | Check the form; get or create the device user | `AddNetworkScreen.tsx:220` |
| 2 | Run create inside a one-shot founding window | `engine-factory.ts:317` |
| 3 | Make a random network id, then hash it | `networks-engine.ts:95` |
| 4 | Open the strand as founder; cadre-core applies the schema and writes the header and membership rows | `rn-db-factory.ts:179-244` |
| 5 | Write six founding rows: User, UserKey, Authority, Admin, Officer, Network | `rn-db-factory.ts:193-279` |
| 6 | Select the network; Invite voters mints a `vtjoin2.` code (1,000 uses, 30 days) | `voter-invite.ts:169` |
| 7 | Voter join: refuses with no peer, refuses a phone in another authority's group, waits for all six founding rows within 120 s, checks the digest | `networks-engine.ts`, `network-join.ts` |

### What keeps running in the background

- The node keeps its peer group alive and keeps retrying the relay reservation.
- It asks peers for strand addresses every 30 s.
- It hosts the vote-pool meeting point (the rendezvous) during voting.
- Writes land in local LevelDB and copy to connected members. Nothing pushes data to a relay on its own.
- With `strandReactivity` on, the node also hosts the cohort-topic service that live table watches and matchmaking run on.

### Caveats

- The relay address the officer types is stored but never dialled, as the comment in `AddNetworkScreen.tsx` says.
- Release builds can't mint join codes, because the committed relay list is empty. (The working copy points at the inspiringlab relay, uncommitted.)
- Create always founds a new strand, so a relay pointed at the same id forks it.
- A digest mismatch fails a join for good; it is never retried.
- New: a phone can belong to only one authority's group. Since `e81c9736` it gets a clear refusal instead of a hang, but a voter of two authorities still can't join both.

---

## 2. What happens after a voter submits

1. Submit: the phone builds the vote, signs it with the hardware key and seals it. The voter sees "Vote saved — not sent". Nothing is sent yet.
2. Send my vote: the phone first checks that it can reach the Authority's meeting point. If it can't, no prompt appears.
3. Pooling: the voter sees "Waiting for other voters (N so far, 3 needed)". Leaving the screen stops the send.
4. Confirm: one biometric prompt per block, ending at "Sent to the election."
5. After the keyholders release their key shares, the voter can open Timeline, then Tallying, then View results. The phone counts the votes itself. Once an officer publishes the count, the screen also says whether it matches the phone's count. There is still no "verify my vote" screen.

---

## 3. How blocks form and how tallying works

### Pool rules (`packages/vote-engine/src/pool/pool-agent.ts`)

- Topics widen from 2-bit to 1-bit to the plain topic within 15 s.
- A pool holds 3 to 16 voters. It forms when full, after 20 s with no growth, or 60 s before voting closes, and never below 3 voters.
- Members get 120 s to sign. A coordinator that goes silent is dropped after 60 s.
- A phone that can't show a prompt holds no pool.

### Block steps (`pool-block.ts`)

1. Each vote is encrypted to the election key under a throwaway identity.
2. The voter who forms the block sorts the votes by their bytes, so the order reveals nothing, and encrypts the block.
3. Members check the block and sign it. Refusers and duplicate voters drop out and the rest re-form.
4. One strand transaction writes the block and its voter rows.
5. The schema enforces the rest at write time: digests, one vote per voter per ballot, signatures, the voting window, and rows that can never change (`votetorrent.qsql:3312-3414`).

### Tallying is wired end to end

On 2 Nov two commits connected the tally code, which until then nothing called.

`a82acce6` adds counting on the device:

- `ElectionResultsEngine` rebuilds the election key from the public released shares, opens every committed block of the current revision, validates the votes and builds the tally tree. Then it wipes the key.
- A Results screen in each app shows per-option counts, invalid and excluded totals, and the tally root. It shows a locked state until enough shares are released.
- On a host rehearsal, the officer's count equalled the cast votes and a keyholder peer reached the same tally root.

`3f5e192e` adds publishing:

- A new table, `ElectionTally`, holds one signed row per election revision and can never be updated or deleted. The schema refuses the row unless the roots match the stored tree, the keys are released, the publisher is a current officer of the authority, the key is the publisher's own, and the signature is valid.
- On the Authority Results screen, an officer sees Publish results once every block on the device has all its voter rows. The officer confirms the block and vote counts, then one biometric prompt signs the row. It is a button rather than a background job, because the officer's key always asks for a fingerprint or face and a published count can't be corrected.
- Both Results screens show the published count and say whether it matches the device, differs (with both block counts), or failed its signature or consistency check.
- The screens recount on their own when a key share, a block or a published count arrives.

Still open:

- It has now run on emulators (D1-D5 passed, section 0), but not on a real phone officer. A keyholder device can lack the last vote block for about 2.5 minutes after the release; its screen then updates by itself.
- The tally counts select questions only; ranked, score and text questions show only how many answered.
- The block-coverage check can't see a block that hasn't reached the device at all, which is why the officer confirms the count before publishing.

---

## 4. Do we use the latest APIs for reactivity and matchmaking?

Yes for the phone apps since 2 Nov, and for the Public page since 3 Nov. The dashboard is next (Phase 66).

### Versions (npm, 2 Nov)

| Package family | Before | Now | Newest |
|---|---|---|---|
| @serfab (cadre-core) | 1.19.1 | 1.20.0 | 1.20.0 |
| @optimystic | 1.20.1 | 1.24.0 | 1.24.0 |
| @quereus | 4.21.1 | 4.24.0 | 4.24.0 |
| p2p-fret | 1.2.1 | 1.3.0 | 1.3.0 |
| libp2p | 3.3.11 | 3.3.11 | 3.5.1 |

cadre-core 1.20 needs optimystic 1.23+, quereus 4.23+ and fret 1.3, so these had to move together. optimystic 1.23 is a breaking change: client signatures move to `txsig:v3`, so every machine on a network has to upgrade together. Our three yarn patches carried forward. A probe confirmed that a network written on the old stack opens on the new one with its rows intact. No stack bump since 2 Nov.

### Reactivity

| Surface | Before 2 Nov | Now |
|---|---|---|
| Voter and Authority apps | Re-read on screen focus, on timers and on app resume | Strand nodes run with `strandReactivity`, and a shared change hub re-reads a screen when a table it shows changes. Wired into Voter Home; Authority Elections, Tasks and Registration Inbox; and both Results screens |
| Schema | No watch tags | 11 tables tagged `optimystic.network_watch`. A tag-only change is a catalog update, so existing networks still open |
| Public view | Hand-built subscription with its own renewal timer | Since 3 Nov, one `node.reactivityWatch` per table (`a73b6f78`, `6cffa26c`). Proven in a two-node harness; the browser test reaches 6 of 10 steps |
| Dashboard | Static by design | Phase 66 will make it live; plans are being written |

On two real nodes, a commit on one woke a watch on the other in about 0.5 s. The Public page gets the same 0.5 s once its watch registers; the first registration waits one 20 s watch tick. The CPU cost on the Redmi is not measured yet; on the emulator Authority it was about 1.1-1.2 cores.

What still blocks the Public page in the browser:

- Step 6 of the browser gate fails on the read layer's row-count record (`RowCountMismatchError`). That is an open Phase 56 decision.
- Step 10 found the page's store without the row the origin had just changed, even though the harness case for a first row now passes. Not explained yet.

### Matchmaking

- The Voter finds pools through the Authority rendezvous and optimystic 1.24 matchmaking together (your choice on 2 Nov). The mailbox stays on the rendezvous.
- A matchmaking listing is signed by the pool's own identity over the topic, the size, the time and the registering peer id, so nobody can forge one or replay it under another peer.
- Matchmaking won't form pools on our networks yet. A registration needs 14 of 16 cohort members to sign it, so every network smaller than that refuses it. The Voter then pauses matchmaking for 30 s and the rendezvous carries the pool. The emulator test confirmed this: refused, then pooled through the rendezvous in about 8 s. A harness test pins the refusal and will fail once upstream changes the threshold.
- Privacy cost, which you accepted: a phone that registers shows its libp2p peer id to that topic's cohort members. The rendezvous alone showed it only to the Authority.

---

## 5. Which user actions take the longest, and why

| Action | Measured | Main cause |
|---|---|---|
| Officer approves a registration | 50-60+ min on the Redmi, about 9 min on the Samsung, about 75 s on the iPhone | Every write waits for the slowest member of the peer group |
| Officer's first Sync Now | 5-10 min with phones as members, about 30 s on the iPhone | Phones answer in seconds, host peers in milliseconds |
| Joining a network | Usually 11-65 s, 6-10 min at worst; now always ends by 120 s | Block catch-up retries, stale peers, a slow founder |
| Keyholder key generation | 2.5 s on the host, 4-6 min on the Redmi | Phone CPU; the prompts per keyholder drop from 17 to 4 with `bcbf1902` |
| Cold start (debug builds) | 19 s on the iPhone, 36-104 s on the emulator | Debug Hermes compiles a 52 MB bundle |
| Registration confirm | 180 s per try, often two tries | Waits for the officer's Sync Now |
| Sending a vote | About 10 s after confirm, 3+ min if a prompt is missed | Fixed time windows; needs 3 voters |

The same keyholder key generation by device: host 2.5 s, iPhone 40 s, Android emulator 46 s, Samsung A24 83 s, Redmi 8 4.2-5.8 min.

### Common causes

1. Low-end phone CPU matters most. The Redmi's JavaScript thread is about 85% busy on encryption, socket bridging and peer-id churn, and the whole group waits for it.
2. Replication round-trips: slow phones hit the 7 s and 16 s timeouts, join catch-up retries 3 times, and "Missing block" errors are never retried.
3. Debug builds carry about 600 MB of debug Hermes code, and the test emulators swap memory. Release builds were never timed, so these numbers may overstate real use.
4. Fixed timers: confirming a registration waits 180 s, pool discovery takes 15-35 s and the signing window is 120 s.
5. Prompts run one after another: 2 per vote sent and 4 per ballot. A keyholder used to answer about 17 per election (about 11 Face ID prompts on iOS for key generation alone). With `bcbf1902` it is 4 on the host, and today's phone run read 0 at accept and 3 for key generation on the iPhone. A missed prompt costs a 2-minute window. Publishing a tally adds one prompt for the officer.
6. Relay and clocks: a slow first relay attempt adds about 18 s to half of relay-only opens (fixed upstream, not re-checked by us), and emulator clocks drift 5-45 s, which expires transactions.

Live screens remove the waiting that came from stale screens (a list now updates when the data lands, without leaving and coming back). They don't speed up replication itself.

---

## 6. Last month (2 Oct to 2 Nov)

773 code commits and 1,073 planning commits. Phases 63 and 64 finished. On 3 Nov, 9 more code commits and 50 planning commits.

| Week | Code commits | Highlights |
|---|---|---|
| Oct 2-8 | 452 | Phase 62 multi-peer work (shared signing, keyholder key generation); Phase 63 done (vote signed and stored on the phone); React Native 0.78 to 0.87 |
| Oct 9-15 | 109 | Join by code and send through a pool, proven on the host; the 4 MiB connection cut fixed; native crypto; Phase 64 planned (QR join, camera scan) |
| Oct 16-22 | 26 | Small UI fixes; stack bump (serfab 1.16, optimystic 1.15); the three-emulator test rig ran out of memory |
| Oct 23-29 | 49 | Fixes for database forks, late joiners missing blocks and cold restarts; the iPhone memory leak patched; a Node command-line tool that runs whole workflows |
| Oct 30-Nov 2 | 137 | Phase 64 done on real phones; Phase 65 block tree, validation and tally; the Android second-prompt fix; on 2 Nov, Results screens, the stack bump, live screens, matchmaking and the published tally |

### Stack movement

| Package | 2 Oct | 2 Nov |
|---|---|---|
| @serfab/cadre-core | 1.9.0 | 1.20.0 |
| @optimystic | 1.9.0 | 1.24.0 |
| @quereus | 4.20.0 | 4.24.0 |
| p2p-fret | 1.0.0 | 1.3.0 |
| main-event | 1.0.4 | 1.0.5 |
| libp2p | 3.3.2 | 3.3.11 |
| React Native | 0.78.0 | 0.87.1 |

### Phone-to-phone replication (P2P-11)

- 8-9 Oct: 4 of 8 passed (50%)
- By 12 Oct: 21 of 28 (75%)
- 30 Oct: 19 of 22 (86%)
- 31 Oct: the public relay works end to end, but joins failed 2 of 2 times when the Redmi founded the network.
- No new P2P-11 runs since.

### Upstream issues

10 filed this month, and 5 are already fixed upstream. Still open: Optimystic#35, Optimystic#36, sereus#46 and quereus#34.

### Defects found and fixed

| Defect | Fix |
|---|---|
| Connections were cut after 4 MiB | `c892c55e` |
| Crypto ran in slow JavaScript on both apps | `e95f64b7`, `58943e71` |
| iPhone Voter killed at about 2 GB by a native memory leak | `91937943` |
| Android silently dropped a second fingerprint prompt | `f7fa26f2` |
| Android made a new device key on every lookup | `d2ce1446` |
| An upgrade left existing installs unable to boot | `b1fe49a6` |
| Joined phones failed every cold restart | `7f7d3443` |
| Late joiners missed earlier blocks | `014929e7` |
| The control database forked and sockets leaked | `9465fcf4`, `fa25450c` |
| Two keyholders wrote the same row | `274774c1` |
| A fresh debug Voter hung on "Syncing" | `a7c804a4` |
| New 2-3 Nov: a fresh iOS install broke its own database | `3443b5c9` |
| New 2-3 Nov: joining a second authority's network hung | `e81c9736` (quick fix) |
| New 2-3 Nov: the Public page was on the wrong network name and counted as storage | `a73b6f78`, `6cffa26c` |

### Host test results

On `3f5e192e` (2 Nov):

| Suite | Result |
|---|---|
| vote-engine | 3,772 passing, 8 failing; the 8 are exactly the known, pinned failures |
| Voter app | 3,399 of 3,399 |
| Authority app | 4,987 passed, none failed |
| Typecheck | Voter clean; Authority unchanged (38 known errors) |
| Android release bundles | Both build |

Since then, as reported in the commits (no full re-run of every suite):

| Check | Result |
|---|---|
| Public node suite (`6cffa26c`) | 630 of 633; the 3 failures are the same as at `e81c9736` |
| Public typecheck | At its 12 known errors |
| Public edge-watch harness | 3 of 3 runs |
| Host election driver self-check (`967acbf4`) | 21 of 21 |
| Host three-keyholder dry run (`967acbf4`) | Passed |

---

## 7. What is open now

- The three-phone keyholder run is still going. It has to finish the vote, the release and the tally, and record the release prompt count.
- The merge test still owes two legs: Redmi CPU and memory with live screens, and Publish on a real phone officer.
- Phase 65 has closed all its device gaps. It still needs the spike-102 host check, which needs a quiet host, and its ROADMAP still shows plans 65-10 to 65-19 unticked.
- F1, two authorities on one phone, has its quick fix, but nobody has checked it on a phone. The real fix needs a choice between one party id per authority and "leave the old network and join this one".
- The Public page is stuck at 6 of 10 steps in the browser, behind the Phase 56 row-count decision and a stale row nobody has explained.
- Keyholder prompts are down to 4 per keyholder on the host. Real phones show it only with a new app binary, and seats accepted before `bcbf1902` keep the old count.
- Phase 66 plans are being written (20 of 27). No code yet.
- P2P-11, the root blocker, is at about 86% and not closed. Joins fail when the Redmi founds the network.
- Of the older phases, 38 and 41 are paused on P2P-11; 51, 54, 55 and 56 have open UAT or gates; 62 still owes some Android and iPhone test legs.
- Housekeeping:
  - Uncommitted: the Maestro suite, the Voter tab test ids, the gate diagnostics, and the relay address in both `bootstrap.config.json` files.
  - `tools/lean-rig` needs one host run before it can be merged.
  - 112 todos are pending.

## 8. Next steps

The 2 Nov list, with where each item stands:

| # | Step | Status 3 Nov |
|---|---|---|
| 1 | Device test of the merge with the other session | Done on emulators (D1-D5 pass). Owed: the Redmi CPU leg and Publish on a phone officer |
| 2 | Close Phase 65; fix the second-network hang and the iOS fresh-install break | Device gaps closed; F4 fixed and checked on the iPhone; F1 quick fix on the host. Owed: spike-102 host check, F1 on a phone |
| 3 | Move the Public view to `node.reactivityWatch` | Done in code and in the harness. Browser 6 of 10, blocked by the Phase 56 decision |
| 4 | Keep weak phones out of write groups; time a release build | Not started. Keyholder prompt cut (`bcbf1902`) is a related win |
| 5 | Re-check matchmaking when upstream lowers 14-of-16 | Waiting on upstream |

Recommended next, in order:

1. Finish the three-phone run, and record the release prompt count and the tally match.
2. Run the Redmi CPU leg and Publish on a phone officer, which closes step 1.
3. Run the spike-102 host check when the host is quiet, then mark Phase 65 complete and tick its ROADMAP plans.
4. Finish the Phase 66 plans and start the first wave. It first checks the riskiest assumption: that a joined browser node gets strand data and watch wake-ups.
5. Make the Phase 56 row-count decision, which unblocks the Public page in the browser.
6. Choose the F1 real fix, before any work with more than one authority.
7. Commit the Maestro suite once one flow passes on a device. Run `tools/lean-rig` once and merge it.
8. Then steps 4 and 5 above: weak phones and release timing, and matchmaking when upstream moves.
