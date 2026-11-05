# vote-cli — the Authority and Voter workflows from Node

`vt` runs the same workflows as the VoteTorrent Authority and Voter apps without React Native or
Hermes. It calls the built `vote-engine` (`dist/rn-entry.js`, the entry both apps import) and the
same `@serfab/cadre-core` / Optimystic stack, resolved through `packages/vote-engine/node_modules`
so the repo's yarn patches apply. Each workflow mirrors one screen action; the source cites the
screen and engine helper it follows.

## Model

A **device** is one daemon process: what one phone running an app holds. It has its own identity
keys, its own CadreNode (libp2p over WebSockets) and its own engines. `vt daemon start` launches a
device in a home directory; every other command is a JSON-RPC call to that device.

```sh
cd tools/vote-cli
node bin/vt.mjs --home .vt/A  daemon start --role authority --name "Alice Officer"
node bin/vt.mjs --home .vt/A  network create --name "My Network"
node bin/vt.mjs --home .vt/A  intake-key register
CODE=$(node bin/vt.mjs --home .vt/A network join-code | node -pe 'JSON.parse(require("fs").readFileSync(0)).code')

node bin/vt.mjs --home .vt/V1 daemon start --role voter --name "Voter One"
node bin/vt.mjs --home .vt/V1 network join "$CODE"
```

Run `node bin/vt.mjs help` for every command. Output is JSON; `--json` adds the daemon-side
duration. `--home` defaults to `$VT_HOME`, then `./.vt/default`.

Before running, build the engine (`yarn build` in `packages/vote-core`, then `packages/vote-engine`).
The CLI refuses to start on a `dist/` older than the engine source.

## Workflows

| App | Workflow | Commands |
|---|---|---|
| Authority | Found a network (9 founding scopes, rn/mel/ceb threshold 1) | `network create`, `network show`, `admin show` |
| Authority | Network revision | `network revise [--relay …] [--no-apply]` |
| Authority | Invite voters / officers to the network | `network join-code` |
| Both | Join a network from a `vtjoin1.`/`vtjoin2.` code | `network join <code>` |
| Authority | Officers | `officer invite`, `invite accept <share>`, `admin set-scopes` |
| Authority | Officer intake encryption key | `intake-key register` |
| Authority | Elections | `election create`, `election list`, `election show` |
| Authority | Ballots | `ballot propose`, `ballot submit`, `ballot confirm`, `tasks list`, `tasks sign` |
| Authority | Registration policy | `registration field-add` |
| Authority | Registration intake and review (Sync Now, approve, reject) | `registration sync`, `registration list`, `registration approve`, `registration reject`, `registrants list` |
| Authority | Keyholders: invite, accept, DKG, key release | `keyholder invite`, `keyholder accept <share>`, `keyholder dkg [--until-done]`, `keyholder status`, `keys release` |
| Voter | Register and associate the device (sealed request, challenge, attestation) | `register`, `registration status` |
| Voter | Election, timeline, ballot | `election show`, `ballot show` |
| Voter | Cast (signed + sealed locally), receipt | `vote cast --select q=opt`, `vote receipt` |
| Voter | Send the vote in a pool (min 3) via the authority's rendezvous | `vote send` |
| CLI only | Reconstruct the key, open the blocks, tally | `election results` |

## What is substituted

| App seam | CLI stand-in |
|---|---|
| AsyncStorage | `<home>/local.json` |
| Keystore / Secure Enclave keys | software secp256k1 identity key and P-256 voting key (`<home>/identity.json`, mode 0600) |
| Play Integrity / key attestation | the dev-build stub attestation; the authority uses `StubAttestationVerifier` — **attestation is not verified** |
| Hardware-wrapped key vault | process memory |
| rn-leveldb storage | `MemoryRawStorage`: a device's network state lives as long as its daemon |
| Relays / NAT | none; all devices on 127.0.0.1. The founding authority uses the `storage` profile so peers can dial it |

## End-to-end test

```sh
node test/e2e.mjs                         # ~8–10 min, mostly waiting on the compressed timeline
node test/e2e.mjs --voting-starts-min 4 --voting-min 3 --keep
```

It starts 7 devices (authority, two keyholder devices, three voters, and one voter for a
forged-code check) and drives every workflow above only through `vt`. The report goes to
`reports/E2E-REPORT.md` (with `reports/e2e-results.json`); per-run device homes and daemon logs go
to `runs/<stamp>/`.
