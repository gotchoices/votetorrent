# Public-Observer Gateway — Deploy Recipe

`packages/p2p-probe-host/gateway.mjs` (Phase 56, D-12) is a storage-profile `CadreNode` that lets
an unauthenticated browser peer resolve strand addresses for a public election's strand, over a
real TLS WebSocket listener, gated by a node-local fail-closed allowlist. This document is the
deploy recipe for running one.

## 1. NON-CLAIM — read this first

This phase delivers a **locally-proven** WSS node plus this recipe, proven over loopback on one
development host. It does **NOT** prove the following, and none of them should be inferred from
anything below:

- **"Reachable from the open internet" is an explicit NON-CLAIM.** Nothing in this phase
  demonstrates that the gateway is dialable from outside the host it runs on — no port-forward,
  no NAT traversal, no public DNS record, no cloud deployment was exercised. Section 7 describes
  two routes to a real deployment; both are labeled UNTESTED HERE.
- **The certificate is trusted only on hosts where the mkcert local CA is installed.** This is a
  development certificate authority, not a publicly-trusted one — see Section 3.
- **Nothing here proves the gateway survives adversarial load.** See Section 8's "known
  non-mitigation": there is no rate limiting and no cap on anonymous observer connections.

Repeated as a closing checklist in Section 9 — if you only read one section besides this one,
read that one too.

## 2. Prerequisites

- **`brew install mkcert`** — automatable, and `packages/p2p-probe-host/scripts/make-gateway-cert.sh`
  refuses to run without it (no self-signed fallback).
- **`mkcert -install`** — the one manual step. It writes the local CA into the host's system trust
  store via `sudo security add-trusted-cert` (macOS) and **prompts for the admin password**. This
  cannot be automated from an unattended script; run it once, interactively, per gateway host.
- **`NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`** — set this for every Node process that
  *dials* the gateway (an anonymous observer probe, a Node-side test harness, `56-11`'s runner).
  Without it, a dial to the gateway fails with a TLS chain-validation error that has **nothing to
  do with admission** — do not misread a missing env var as a refusal by the connection gater.

## 3. Certificate

Run:

```
yarn workspace p2p-probe-host gateway:cert
```

This issues an mkcert leaf for `localhost`, `127.0.0.1`, and `::1` into
`packages/p2p-probe-host/certs/gateway-cert.pem` / `certs/gateway-key.pem`. The private key is
written `chmod 600` and the whole `certs/` directory is gitignored — key material never enters
git. Rotate by re-running the same command; it overwrites both files.

**Mechanism decision, and both rejected alternatives** (RESEARCH Open Question 4 / Assumption A4
was left open; this document is where it was settled):

- **Chosen — mkcert-issued leaf from a locally-installed CA.** Both Node
  (`NODE_EXTRA_CA_CERTS`) and `56-11`'s Playwright Chromium validate a **genuine chain** against
  it, so a broken TLS configuration can still fail the gate that consumes this gateway. It also
  generalizes cleanly to Section 7's real-deployment routes — only the issuer changes.
- **Rejected — self-signed certificate + a browser TLS bypass**
  (`--ignore-certificate-errors`). This disables certificate validation **globally** in the gate's
  browser, so a gate built on top of it could never fail on a broken TLS setup. A green gate that
  cannot fail proves nothing.
- **Rejected — a hand-rolled openssl CA.** The hard part of "real certificate handling" is the
  per-platform trust-store install, which is exactly what mkcert exists to do correctly.
  Hand-rolling an openssl CA is more code, less portable, and still needs the same admin prompt.

## 4. Configuration

`packages/p2p-probe-host/gateway.config.json` (gitignored — copy from
`gateway.config.example.json`), every key **required**, none defaulted:

| Key | Type | Fail-closed behaviour |
|---|---|---|
| `partyId` | string | Required, non-empty. |
| `listenHost` | string | Required, non-empty. |
| `publicObserverStrandIds` | string[] | Required, **non-empty**. An empty or absent list refuses to boot — on a node whose entire purpose is public observation, an empty allowlist is a silently useless gateway, and that is exactly what gets misread downstream as a fourth wall. The key name matches `CadreNodeConfig.publicObserverStrandIds` **exactly** — there is no translation layer to get wrong — and it is node-local (D-03): never replicated, never reachable from the control DB. |
| `enableRelay` | boolean | Required — **absent is fatal**, present-and-`false` boots normally. This is **transcribed from `56-01-WALL-PROOF.md`'s measured relay posture**, not a shortcut default. Inheriting `drone.mjs`'s posture, or the storage profile's implicit `relayServerEnabled()` default of `on`, is a **configuration error**, not a convenience. |
| `strandCohortTopic` | `{ enabled: boolean }` | Required — **absent, or a non-object, is fatal**; `enabled: false` boots normally (the fail-closed default). This is the master switch for whether the gateway's strand node ORIGINATES reactivity notifications; the gateway passes it to cadre-core's own `strandReactivity` option. A `minSigs` key is **refused** — see below. |
| `tls.certPath` / `tls.keyPath` | string | Must resolve (relative to the config file) to a readable file. |

**Operator action required.** `gateway.config.json` is gitignored, per-operator state. If your
existing config file predates this key, boot will now refuse with a named fatal
(`config key "strandCohortTopic" is required...`) until you add it — transcribe the shape from
`gateway.config.example.json`.

**`minSigs` is no longer a gateway setting.** Earlier gateways took
`strandCohortTopic.minSigs` and treated it as a two-sided number shared with the browser's
`PUBLIC_COHORT_MIN_SIGS`. cadre-core's own `strandReactivity` (1.12+) takes no host tuning, and
upstream states that `cohortTopic.host.minSigs` does not govern the reactivity root: a reactivity
root is the tail block's storage group, verified at the consensus super-majority. The gateway now
refuses a config that still sets it, so an operator never believes it does something. If your
`gateway.config.json` has `"minSigs"`, delete that key.

## 5. Running it

```
yarn workspace p2p-probe-host gateway
```

Prints machine-readable `[gateway] KEY=value` lines: `GATEWAY_CADRE_CORE_PATH=`,
`GATEWAY_RELAY=on|off`, `GATEWAY_AUTHORIZED_MEMBERS=`, `GATEWAY_LIVE_CADRE_INVITATIONS=` (must be `0`),
`GATEWAY_CONTROL_ADDR=` (the `/tls/ws` control multiaddr), `GATEWAY_CONTROL_ADDR_DNS=` (a
`/dns4/localhost` rewrite of the same address, labeled as a rewrite, not an independent
observation), and one `GATEWAY_STRAND_ADDR[<strandId>]=` per hosted strand.

Run `yarn workspace p2p-probe-host gateway --self-check` to also produce the handoff file,
`packages/p2p-probe-host/gateway-runtime.json` (gitignored). It carries the control/strand
addresses, the TLS pin, the provenance verdict, and the effect-rung results, then exits.

**Staleness rule.** Ports are ephemeral and change every boot. A consumer of
`gateway-runtime.json` (`56-11`, `56-13`) **must confirm `pid` names a live process** before
trusting `controlAddrs`/`strandAddrs` — a stale handoff pointing at a dead port is the same
failure class this project already paid for once
(`project_device_proof_bundle_provenance`: a stale Metro server served the wrong bundle for three
runs before the pattern was named).

## 6. Provenance — never trust a result from an unverified gateway

`PROVENANCE=PASS` on stdout, printed **before** the first `GATEWAY_*` line, means: the
`@serfab/cadre-core` copy this specific running process resolved (via `import.meta.resolve`, not
a hand-picked path) carries the 56-04 public-observer patch, verified by importing
`STRAND_OBSERVER_PROTOCOL` from that copy's own export (never a literal copied into
`gateway.mjs`) and finding it in exactly one file, exactly once, comment-stripped.

Re-check independently at any time with:

```
node gateway.mjs --check-dist <path-to-a-@serfab/cadre-core-package-root>
```

Provenance is a **per-workspace** property — this repo's `nmHoistingLimits: workspaces` yields
three separate `@serfab/cadre-core` copies and **no root copy** — so a check against some other
workspace's copy proves nothing about this gateway process. Against a pristine, unpatched 0.12.0
package (e.g. `npm pack @serfab/cadre-core@0.12.0`), `--check-dist` exits non-zero with
`PROVENANCE=FAIL:token-unavailable` — the check fails at the missing export, never at a
misleadingly clean zero-count.

## 7. Generalizing to a real deployment — described, not tested

Both routes below are **UNTESTED HERE** — this phase proves loopback only.

**(a) The same `https: { cert, key }` seam with a publicly-trusted certificate** (ACME /
Let's Encrypt). Only the certificate issuer changes; `gateway.mjs`'s `webSockets({ https: {...} })`
construction is unmodified. UNTESTED HERE.

**(b) TLS terminated by a reverse proxy, with `network.announceAddrs`.** Not a drop-in: an
announce address naming a fixed public port names the **control** node's port, while a fixed
*listen* port collides with the strand node at bind time
(`strand-instance-manager.js:262-292` — control and strand nodes inherit the same resolved listen
list). Whatever gives strand nodes their own listen port has to give them their own announce
addresses in the same pass, or a strand will advertise an address that reaches the control node
instead. UNTESTED HERE.

## 8. Security posture of running one of these

An operator running this gateway can observe, for every connecting reader: source IP, connection
timing, and which election (strand) was asked for — and could correlate those across requests.
This is not mitigable by a node that must accept connections in order to serve them. `SECURITY.md`
and `56-15` carry the authoritative D-10 claim — **unlinkability only**, no durable identifier
links visits across sessions — explicitly **not** a full-anonymity claim; this document does not
restate that claim more broadly than `56-15` states it.

**known non-mitigation, named as such:** there is **no rate limit** and no cap on anonymous
observer connections. The connection-level admit branch this gateway's patch adds is
unconditional — any peer may always open a connection and ask. What bounds this gateway at all is
entirely **inherited, not designed**: the observer service's `maxConcurrent` inbound-stream cap,
its frame-size cap and read timeout, libp2p's own connection-manager limits, and — only when
`enableRelay` is `true` — `MAX_UNAUTHORIZED_RELAY_RESERVATIONS`. None of these is a rate limit.
D-03's allowlist bounds **what** is served; it says nothing about **how many** peers may ask.
`56-15` carries this into `SECURITY.md` and files the upstream issue.

**`strandCohortTopic` (cadre-core `strandReactivity`) widens the reachable surface, named as such.** Enabling the cohort-topic
host on a strand node registers the cohort-topic register/renew/sign/gossip protocols and the
reactivity notify/recover protocols on a node an unauthenticated observer can already reach (via
Section 6's provenance-gated address resolution). This is a real widening, not incidental tuning
— it is bounded by the same allowlist that already governs which strands are observable at all,
but nothing new rate-limits it. Rate limiting stays deferred, exactly as above.

## 9. Non-claims checklist

- [ ] "Reachable from the open internet" — **NOT** claimed; **NOT** demonstrated; **NOT** implied
      by anything else in this document.
- [ ] The mkcert certificate — trusted **only** on hosts with the local CA installed; not a
      publicly-trusted certificate.
- [ ] Survival under adversarial load — **NOT** proven; no rate limiting exists (Section 8).
- [ ] Controls 1 (patch-removal, `56-13`), 2 and 3 (members-only / allowlist-over-the-wire,
      `56-07`) — **NOT** this document's or this gateway process's claim; see Section 6 for what
      provenance here does and does not cover.
