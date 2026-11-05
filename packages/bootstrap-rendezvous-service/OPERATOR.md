# Operating the bootstrap rendezvous service

This document is written for the person who runs an authority. It assumes you have never read this
codebase and does not require you to.

Everything below is executed end to end by `scripts/run-bootstrap-operator-smoke.sh`, which extracts
the fenced blocks from *this file* and runs them. If a step here needs improvisation to succeed, that
is a defect in this document — see [Verifying this document](#verifying-this-document).

---

## What this is, and what it is not

This service holds one sealed blob it cannot read, for at most ten minutes, and hands it over exactly
once. An officer's phone mints a one-time sign-in code and pushes the sealed voter-roll snapshot
here; a browser that has never met that phone redeems the code and gets the blob. The decryption key
is derived from the code's secret half and never reaches this process.

**This is not the libp2p circuit relay.** It has no peers, no multiaddrs, no strand and no cadre, and
it never dials anything. "Relay" elsewhere in this project means a different component entirely, with
a different configuration surface. Nothing you set here affects it, and nothing you set there affects
this.

**One process, one port, two roles.** The same process serves the API *and* the authority dashboard's
built `dist/` directory. That is forced, not a convenience: the dashboard reads its API base URL from
`window.location.origin` at runtime, so the API and the client it talks to must share an origin. The
consequences are worth stating up front, because they remove work rather than add it:

- There is no CORS configuration, because there is no cross-origin case.
- There is no second port to open, and no second process to supervise.
- Whatever is in the build directory you point this service at is what every officer's browser
  executes. That makes [rebuilding the dashboard](#rebuild-the-dashboard-before-every-deploy) the
  single most consequential step in this document.

---

## Deployment posture

**You run your own.** There is no shared, project-operated instance of this service, and nothing in
the design assumes one: each authority runs a service at its own origin, serving its own dashboard,
holding only its own officers' pending blobs. That is deliberate. A shared always-on component would
be one thing to compromise in order to reach every authority at once, and there is not one to
compromise.

Two consequences follow directly, and neither is negotiable:

**Single host only.** The single-use guarantee — a code can be redeemed once and never twice — comes
from an atomic filesystem link. That primitive is single-filesystem by construction. Two processes on
one host sharing one data directory are fine. Two hosts are not: they would each honour the same code
once, which is exactly two deliveries of a one-shot credential. Do not put this behind a load
balancer spraying across machines, and do not put the data directory on a network share.

**It ships as a Node process, not a container image.** There is no image to pull and no orchestration
assumed. A service manager that can set environment variables and restart on failure is the whole
requirement; a `systemd` unit is given [below](#running-it-for-real).

---

## What your service can and cannot see

You are the operator. This is the complete list of what that position gives you.

| Capability | Yes or no | What that means in practice |
|---|---|---|
| See *that* a redemption happened, and when | **yes** | Request timing is visible to you, as it is to anyone running any server. In the default logging mode nothing is written down, but the socket is yours. |
| See the opaque look-up identifier a code maps to | **yes** | It is derived from the code's secret half; it is not the secret and cannot be turned back into it. It identifies a pending blob, and nothing else. |
| Read the sealed payload | **no** | The content key is derived from the code's secret under a different domain label, and never leaves the phone or the browser. You hold ciphertext and the wrong half of the split. |
| Forge a payload a browser will accept | **no** | The envelope carries its own digest and the browser verifies it against a digest obtained out of band, from the officer reading the code aloud. A substituted blob fails that check. |
| Serve a burned code twice | **no** | The single use is claimed atomically *before* anything is served. Two simultaneous redemptions yield one delivery and one refusal, not two deliveries. |
| Refuse service, or delete a pending blob | **yes** | You can deny. There is no way to design that away — it is your disk. The officer's recourse is to mint a new code, which costs them one screen and a few seconds. |
| Retain ciphertext past its expiry | **only by disabling the sweeper** | And it stays unreadable. Retention is a copy of something you cannot decrypt and cannot use. |

**Retention, in order.** The ciphertext is erased the moment it is served — not on a timer afterwards,
as part of serving. A blob that is never redeemed has its ciphertext erased at its own expiry by the
retention sweep. The payload-free record — a look-up identifier, an expiry and a spent flag, nothing
else — outlives its expiry by the grace window, so that a late attempt is answered precisely
(`used`, or `expired`) instead of degrading to the vaguer `unknown`. When the grace window closes the
record is dropped along with its claim marker, and nothing about that code remains.

---

## Requirements

- **Node `>=20.19`** (`package.json:87`). Older runtimes are not supported.
- **Yarn `4.7.0`** (`package.json:85`, the `packageManager` field). Corepack will select it for you.
- **A POSIX filesystem** the service owns, for the data directory. Not a network share — see
  [The data directory](#the-data-directory).
- **A reverse proxy you supply**, terminating TLS. This service speaks plain HTTP and binds loopback
  by default, on purpose. See [TLS and the reverse proxy](#tls-and-the-reverse-proxy).

---

## Deploy

Run these from the repository root, in order. Each block is executable as written.

**1. Install dependencies.**

```bash
# operator-step: 1 install
yarn install
```

**2. Build the vote engine.** The service imports the shared protocol guards from it, so it must be
built before the service is.

```bash
# operator-step: 2 build-engine
yarn workspace @votetorrent/vote-engine build
```

**3. Build the dashboard. This step is MANDATORY on every deploy — not only the first.** The service
serves whatever is in the build directory; a build left over from a previous version silently ships
superseded JavaScript to every officer. The workspace name is `votetorrent-dashboard`, unscoped.
Read [Rebuild the dashboard before every deploy](#rebuild-the-dashboard-before-every-deploy) before
you skip it.

```bash
# operator-step: 3 build-dashboard
yarn workspace votetorrent-dashboard build
```

**4. Verify the dashboard build.** Two hygiene gates that ship with the dashboard: the first fails if
the bundle picked up a Node polyfill, the second if a test harness reached the output.

```bash
# operator-step: 4 verify-dashboard-build
yarn workspace votetorrent-dashboard assert:no-polyfills
yarn workspace votetorrent-dashboard assert:no-test-harness-in-dist
```

**5. Build the service.**

```bash
# operator-step: 5 build-service
yarn workspace @votetorrent/bootstrap-rendezvous-service build
```

**Now set the environment.** The block below is *not* runnable and deliberately so — the values are
yours, and a placeholder secret must never be executable. Generate the upload token with
`openssl rand -hex 32` (or `node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'`)
and set the same value in the authority app's upload setting; the two halves must match or every
upload is refused.

```
# Required.
export BOOTSTRAP_RENDEZVOUS_UPLOAD_TOKEN="<64 hex characters from openssl rand -hex 32>"
export BOOTSTRAP_RENDEZVOUS_DATA_DIR="/var/lib/bootstrap-rendezvous"
export BOOTSTRAP_RENDEZVOUS_DIST_DIR="/srv/votetorrent/apps/VoteTorrentDashboard/dist"

# Strongly recommended: makes a forgotten dashboard rebuild loud instead of silent.
export BOOTSTRAP_RENDEZVOUS_DIST_SOURCE_DIR="/srv/votetorrent/apps/VoteTorrentDashboard/src"

# Optional; the defaults are shown.
# export BOOTSTRAP_RENDEZVOUS_BIND_HOST="127.0.0.1"
# export BOOTSTRAP_RENDEZVOUS_PORT="8787"
# export BOOTSTRAP_RENDEZVOUS_MAX_UPLOAD_BYTES="8388608"
# export BOOTSTRAP_RENDEZVOUS_GRACE_WINDOW_MINUTES="60"
# export BOOTSTRAP_RENDEZVOUS_SWEEP_INTERVAL_SECONDS="60"
# export BOOTSTRAP_RENDEZVOUS_DEV_LOGGING="0"
# export BOOTSTRAP_RENDEZVOUS_ALLOW_STALE_DIST="0"
# export BOOTSTRAP_RENDEZVOUS_ALLOW_NON_LOOPBACK="0"
```

**6. Preflight.** This runs the same build-directory gate the service runs at startup, while the old
instance is still up. Green means the next restart will bind the port; red means it will not.

```bash
# operator-step: 6 preflight
node packages/bootstrap-rendezvous-service/scripts/preflight.mjs
```

**7. Start the service.** This does not return; run it under a service manager, or in its own
terminal.

```bash
# operator-step: 7 start background
node packages/bootstrap-rendezvous-service/dist/main.js
```

**8. Verify it is serving.** Both roles, on the one port: the dashboard's entry document, and the
redemption endpoint answering for a code it has never heard of. This block exits non-zero if either
fails, so it is an assertion and not just an illustration.

```bash
# operator-step: 8 verify-serving
BASE_URL="http://127.0.0.1:${BOOTSTRAP_RENDEZVOUS_PORT:-8787}"
INDEX_HTML="$(curl --fail-with-body -sS "${BASE_URL}/")"
grep -q 'id="root"' <<< "${INDEX_HTML}"
REDEMPTION="$(curl --fail-with-body -sS -X POST \
  -H 'content-type: application/json' \
  --data '{"lookupId":"operator-doc-verify-probe-not-a-real-lookup"}' \
  "${BASE_URL}/bootstrap/redemptions")"
grep -q '"status":"unknown"' <<< "${REDEMPTION}"
echo "verify-serving: the dashboard is served and the redemption endpoint answers"
```

### Running it for real

A `systemd` unit. The user is unprivileged and owns only the data directory; the build directory is
read-only to it. Set every variable explicitly here rather than relying on a login shell — a service
manager has no login shell, and a variable you forgot is a default you did not choose.

```ini
[Unit]
Description=VoteTorrent bootstrap rendezvous service
After=network.target

[Service]
Type=simple
User=votetorrent
Group=votetorrent
WorkingDirectory=/srv/votetorrent
ExecStart=/usr/bin/node /srv/votetorrent/packages/bootstrap-rendezvous-service/dist/main.js
Environment=BOOTSTRAP_RENDEZVOUS_BIND_HOST=127.0.0.1
Environment=BOOTSTRAP_RENDEZVOUS_PORT=8787
Environment=BOOTSTRAP_RENDEZVOUS_ALLOW_NON_LOOPBACK=0
Environment=BOOTSTRAP_RENDEZVOUS_UPLOAD_TOKEN=<64 hex characters>
Environment=BOOTSTRAP_RENDEZVOUS_DATA_DIR=/var/lib/bootstrap-rendezvous
Environment=BOOTSTRAP_RENDEZVOUS_DIST_DIR=/srv/votetorrent/apps/VoteTorrentDashboard/dist
Environment=BOOTSTRAP_RENDEZVOUS_DIST_SOURCE_DIR=/srv/votetorrent/apps/VoteTorrentDashboard/src
Environment=BOOTSTRAP_RENDEZVOUS_ALLOW_STALE_DIST=0
Environment=BOOTSTRAP_RENDEZVOUS_MAX_UPLOAD_BYTES=8388608
Environment=BOOTSTRAP_RENDEZVOUS_GRACE_WINDOW_MINUTES=60
Environment=BOOTSTRAP_RENDEZVOUS_SWEEP_INTERVAL_SECONDS=60
Environment=BOOTSTRAP_RENDEZVOUS_DEV_LOGGING=0
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/bootstrap-rendezvous

[Install]
WantedBy=multi-user.target
```

Deploying an update is: rebuild the dashboard, run the preflight, then `systemctl restart`. In that
order, every time.

---

## Environment variables

Every knob carries the `BOOTSTRAP_RENDEZVOUS_` prefix. That prefix is not decoration — it is what
keeps these keys from being confused with the unrelated peer-to-peer settings elsewhere in this
project. A name without it is not read by anything.

| Variable | Required | Default | What it does |
|---|---|---|---|
| `BOOTSTRAP_RENDEZVOUS_UPLOAD_TOKEN` | **yes** | — | The bearer secret the phone sends with every upload. Compared in constant time. See [The upload token](#the-upload-token). |
| `BOOTSTRAP_RENDEZVOUS_DATA_DIR` | **yes** | — | Writable directory for records, ciphertext and claim markers. Local filesystem only. |
| `BOOTSTRAP_RENDEZVOUS_DIST_DIR` | **yes** | — | The dashboard's **built** output directory. Point it at `dist/`, never at `src/`. |
| `BOOTSTRAP_RENDEZVOUS_BIND_HOST` | no | `127.0.0.1` | The interface to bind. A non-loopback value is refused unless the opt-in below is set. |
| `BOOTSTRAP_RENDEZVOUS_PORT` | no | `8787` | The port to bind. Your reverse proxy forwards here. |
| `BOOTSTRAP_RENDEZVOUS_ALLOW_NON_LOOPBACK` | no | `false` | Opt-in to binding a non-loopback interface. Unsupported posture; see [TLS and the reverse proxy](#tls-and-the-reverse-proxy). |
| `BOOTSTRAP_RENDEZVOUS_DIST_SOURCE_DIR` | no | unset | The dashboard's source directory. Setting it turns "I forgot to rebuild" from silent into a refusal to start. **Set it.** |
| `BOOTSTRAP_RENDEZVOUS_ALLOW_STALE_DIST` | no | `false` | Opt-in to serving a build older than that source directory. For a deliberate rollback only. |
| `BOOTSTRAP_RENDEZVOUS_MAX_UPLOAD_BYTES` | no | `8388608` (8 MiB) | Hard ceiling on one upload. See the trade below. |
| `BOOTSTRAP_RENDEZVOUS_GRACE_WINDOW_MINUTES` | no | `60` | How long the payload-free record outlives its expiry. See the trade below. |
| `BOOTSTRAP_RENDEZVOUS_SWEEP_INTERVAL_SECONDS` | no | `60` | How often the retention sweep runs. Lower means tighter erasure timing and more filesystem work. |
| `BOOTSTRAP_RENDEZVOUS_DEV_LOGGING` | no | `false` | Opt-in to per-request and per-sweep log lines. See [Logging](#logging-and-what-you-can-see-while-it-runs). |

**The grace window trade.** `BOOTSTRAP_RENDEZVOUS_GRACE_WINDOW_MINUTES` controls how long the
payload-free record survives past the code's expiry. Longer keeps refusal answers *precise* — "that
code was already used" versus "that code timed out" — for an officer who redeems late and needs to
know which mistake they made. Shorter keeps less metadata on your disk. Past the window a late
attempt degrades to the generic "not recognised", which is true but unhelpful. The ciphertext is
gone either way; this window is only about the fact, never the payload.

**The upload ceiling trade.** `BOOTSTRAP_RENDEZVOUS_MAX_UPLOAD_BYTES` is a hard ceiling on a single
upload. Raising it accommodates a larger voter roll. Lowering it narrows how much disk a caller who
holds your token can consume in one request. The refusal names the configured limit in its response
body, so whoever hit it can act on the number instead of guessing — and only a caller who already
holds the token can reach that refusal at all.

**The three opt-in flags are strict.** `BOOTSTRAP_RENDEZVOUS_ALLOW_NON_LOOPBACK`,
`BOOTSTRAP_RENDEZVOUS_ALLOW_STALE_DIST` and `BOOTSTRAP_RENDEZVOUS_DEV_LOGGING` accept only `1`,
`true`, `0`, `false` or empty, case-insensitively. Anything else — `yes`, `on`, `enabled` — is a
**startup failure**, not a silent `false`. That is deliberate: a typo must never quietly leave a
safeguard off, and it must equally never quietly disable logging you believed you had enabled.

---

## Rebuild the dashboard before every deploy

This is the most important section in this document.

**The failure mode.** This process serves the dashboard from a directory on disk. If that directory
holds an old build, browsers get superseded JavaScript against a current API, everything looks
healthy, and the symptom is a screen that behaves as though a fix were never made. Build output is
ignored by version control, so a stale build never appears in `git status` and never shows up in a
review. This project has already lost a debugging session to exactly this failure — a proof passed
every check it had and was vacuous, because the built artifact under test was a day old
(`scripts/check-dist-freshness.sh:15-22` records the incident).

**The guard.** Before it binds the port, the service inspects the build directory and refuses to
start on any of these:

- the directory is missing, or is not a directory;
- there is no `index.html` in it;
- it is really the dashboard's **source** root — its `index.html` still references `/src/main.tsx`,
  which only the un-built document does;
- its `index.html` references an asset that is **not on disk** (a half-written or partly-deleted
  build);
- it holds a file extension the service cannot type, which would reach the browser as an opaque
  download instead of code;
- with `BOOTSTRAP_RENDEZVOUS_DIST_SOURCE_DIR` set, the newest built asset is **older** than the
  newest file under that source directory.

Each refusal prints one fatal line containing `event=config-invalid`, and the port is never bound —
the old instance's socket is not even contended for.

**The recommendation.** Set `BOOTSTRAP_RENDEZVOUS_DIST_SOURCE_DIR` in every deployment. It is
optional only because a deployment that ships a build directory without its source tree cannot use
it. It is the single setting that converts a forgotten rebuild from a silent wrong answer into a loud
refusal.

**The escape hatch, and its cost.** `BOOTSTRAP_RENDEZVOUS_ALLOW_STALE_DIST=1` permits serving a build
older than the source. It exists for one legitimate case: a deliberate rollback to a known-good older
build while you investigate. It costs you the entire guard above for as long as it is set — with it
on, the stale-build failure is silent again. Unset it as soon as the rollback ends; do not put it in
your unit file "just in case".

**The operational rule, in one line: rebuild, run the preflight, then restart.** A build refreshed
underneath a running process is not reliably picked up — the inspection result is remembered for the
life of the process — so a rebuild without a restart is not a deploy.

**How to tell what a browser actually got.** The preflight prints the served entry script and the
first sixteen hex characters of its SHA-256:

```
[preflight] entry script        : /assets/index-DrqjGaBr.js
[preflight] entry script sha256 : 0123456789abcdef
```

Compare that against the script the browser fetched (its developer tools will show you both the URL
and the response). If the server's digest is current and the browser's is not, the problem is a
browser cache, not your deployment: `index.html` is served `no-cache` and the hashed assets are
served `immutable`, so a hard reload resolves it. If the server's digest did not change after a
rebuild, the problem *is* your deployment — you rebuilt something else, or pointed the service at a
different directory.

---

## TLS and the reverse proxy

This service speaks **plain HTTP** and binds `127.0.0.1` by default. TLS is terminated by a reverse
proxy you supply. Here is a working nginx server block:

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name authority.example.org;

    ssl_certificate     /etc/letsencrypt/live/authority.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/authority.example.org/privkey.pem;

    # Keep this ABOVE BOOTSTRAP_RENDEZVOUS_MAX_UPLOAD_BYTES. A proxy limit below the
    # service ceiling produces a proxy-generated refusal that does NOT name the
    # service's configured limit, which is confusing to diagnose and looks like a
    # service fault when it is a proxy fault.
    client_max_body_size 9m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    }
}
```

The Caddy equivalent is two lines:

```caddyfile
authority.example.org {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy's default request body limit is unbounded, so there is nothing to raise; if you set one, keep
it above the service ceiling for the reason given in the nginx comment.

**Exposing the service directly is not the supported posture.** It requires setting
`BOOTSTRAP_RENDEZVOUS_ALLOW_NON_LOOPBACK=1`, and it carries the upload bearer token across the
network in a plaintext header where anyone on the path can take it. Without that opt-in, a
non-loopback bind host is refused at startup with a message beginning:

```
refusing to bind non-loopback host
```

Search your logs for that phrase if the service will not start after you changed the bind host. The
message quotes the host you asked for and names the opt-in variable.

---

## The upload token

**What it protects.** The write endpoint, and only the write endpoint. An ungated write is a
disk-fill invitation that this service is structurally unable to detect, because it can read neither
a genuine upload nor a junk one — every payload is opaque ciphertext to it. The token is the whole
defence, so it must be real randomness: 32 bytes, hex-encoded, from `openssl rand -hex 32` or the
Node equivalent. Do not reuse a password, and do not derive it from the authority's name.

**What it does not protect.** Redemption. That endpoint has no token and no guessing rate limit, on
purpose: a sign-in code carries 160 bits of entropy, so guessing is not a threat a rate limit
meaningfully improves, and a limit would instead give an attacker a cheap way to lock a legitimate
officer out.

**Storage and rotation.** It lives in two places — this service's environment and the authority app's
upload setting — and it must be identical in both. Rotating therefore means updating both halves;
schedule it rather than doing it reactively, because a half-rotated pair means every upload is
refused and the officer sees only "the upload failed". Keep it out of shell history: put it in the
service unit, not in an interactive `export`.

**One refusal, several causes.** A missing `Authorization` header, a header carrying the wrong
scheme, a wrong token, and an oversized body sent *without* a token all answer an identical
`401`, byte for byte. That is deliberate: distinguishing them would hand an unauthenticated caller a
free oracle over your secret. In particular, the size ceiling is disclosed only in the `413` — which
only a caller who already holds the token can reach.

---

## Logging, and what you can see while it runs

**Production is the default and it emits fatal startup errors only.** Not "few" lines — zero, unless
the process is refusing to start.

State the cost to yourself plainly before you accept it: **in the default mode you cannot distinguish
a healthy service from one refusing every redemption.** There is no request log, no error rate, no
counter. If you need that signal — during a rollout, or while diagnosing a report — turn it on
deliberately with `BOOTSTRAP_RENDEZVOUS_DEV_LOGGING=1` and turn it off afterwards.

Every line this service can emit takes one of exactly three shapes, on standard error:

```
bootstrap-rendezvous fatal event=<event> message=<message>
bootstrap-rendezvous request route=<route> outcome=<outcome> latency_ms=<n>
bootstrap-rendezvous sweep ciphertext_dropped=<n> records_dropped=<n> records_retained=<n>
```

The first appears in both modes. The other two appear only with development logging on.

**What those lines cannot carry, and why that is not a promise.** The request and sweep log calls
accept only a fixed vocabulary of route names and outcomes, plus numbers. There is no parameter
through which a look-up identifier, a client address, or a byte of payload could travel — it is the
shape of the functions, not a policy someone remembered to follow. A future change that widened one
of those parameters to free text would destroy the property, which is why the shapes are fixed.

`BOOTSTRAP_RENDEZVOUS_DEV_LOGGING` is the only switch. The conventional `NODE_ENV` deliberately has
**no effect** here, so a framework convention inherited from a surrounding shell cannot turn request
logging on by accident.

---

## What is in node_modules, and why libp2p is there

If you inspect your installed dependencies you will find libp2p, kad-dht and gossipsub. You are
entitled to an explanation rather than a guess.

This service stores its records with a small filesystem key-value adapter from the
`@optimystic/db-p2p-storage-fs` package. That package publishes a **single entry point** and declares
no sub-path exports, so importing the one class this service needs is forced to go through the
package's own barrel — a deep import is rejected outright by Node. The barrel also re-exports a
peer-to-peer storage implementation, and *that* is what references libp2p and its friends. The import
is forced, not chosen.

**No peer-to-peer code runs.** This service joins no network, discovers no peers, dials nothing, and
opens no sockets other than the one port it listens on — the libp2p modules it drags in are
evaluated as definitions and never invoked. That is not an assurance based on reading imports: it is
checked by an automated test that measures the process's live network handles across the import and
asserts that none of the socket, connection or DNS-query handle types appear.

Two benign resources *are* constructed when the graph is evaluated, and they are named here rather
than glossed: a DNS channel (Node's own resolver binding itself at module load) and a standard-I/O
pipe. No query is ever issued through the first, and the second is the process's own stderr.

The visible cost is install size and a little cold-start time. That is all it is.

---

## Endpoints

| Endpoint | Auth | Answers |
|---|---|---|
| `POST /bootstrap/uploads` | `Authorization: Bearer <upload token>` | `200 {"ok":true}`; `401 {"error":...}` for any authentication failure; `413 {"error":...,"limitBytes":<configured>}`; `400 {"error":...,"reason":<token>}` |
| `POST /bootstrap/redemptions` | none | **always** HTTP `200`, body `{"status":...}` — or `{"status":"ok","sealed":...}` when a payload is delivered. `status` is one of `ok`, `unknown`, `expired`, `used`. |

Everything else under the reserved `/bootstrap/` prefix is a JSON `404`, and never the dashboard.
Every path outside that prefix is served from the build directory.

**There is no health endpoint.** No status page, no dedicated liveness path, nothing to poll for a
green light. The liveness check is `GET /`, which returns the dashboard's `index.html` — that is what step 8 of
the deployment uses, and it is a stronger check than a dedicated endpoint would be, because it
exercises the build directory as well as the socket.

**A refusal is still an HTTP 200.** `unknown`, `expired` and `used` are answers, not errors, and the
shipped browser client reads them from the body. If you put something in front of this service that
rewrites, caches or retries on status codes, do not "helpfully" translate those into `404` or `410` —
you will break sign-in and the browser will report a transport failure instead of a clear reason.

**Delivery is at-most-once.** The single use is claimed *before* anything is handed out, so a
response lost in transit burns the code and delivers nothing. The officer's remedy is to mint a new
code. That is the deliberate trade: a code can never be served twice, at the cost of very
occasionally not being served at all. If you see a report of a code that "did nothing and then said
it was already used", this is what happened, and it is not data loss.

---

## The data directory

Under `BOOTSTRAP_RENDEZVOUS_DATA_DIR` the service keeps three separate subdirectories: the
payload-free records (a look-up identifier, an expiry, a spent flag), the sealed ciphertext blobs,
and the claim markers whose mere existence is the single-use fact. The service creates them on
startup; it needs the parent to be writable by the account it runs as.

**Do not back it up.** The entire content set expires within minutes, and a backup of it is a copy of
ciphertext you cannot read, cannot use, and cannot get rid of on the schedule the design promises.
Backing it up converts a deliberately transient store into a durable one and gains nothing.

**Keep it on a local filesystem the service owns.** The single-use guarantee is an atomic link on
that filesystem. A network share may not implement that atomically, in which case two simultaneous
redemptions could both succeed — two deliveries of a one-shot credential. This is also why the
service runs on a single host.

If you need to clear everything — after a test deployment, say — stop the service, delete the
directory's contents, and start it again. Any pending code is invalidated by that, and the officer
mints a new one.

---

## Troubleshooting

The left column is text the service actually prints. Search your logs for it.

| What you see | What it means | What to do |
|---|---|---|
| `refusing to bind non-loopback host` | The bind host is not loopback and the opt-in is not set. | Bind loopback and put a reverse proxy in front. If you truly mean to expose it, set `BOOTSTRAP_RENDEZVOUS_ALLOW_NON_LOOPBACK=1` and understand that the bearer token then crosses the network in plaintext. |
| `which does not exist` (naming the build directory) | `BOOTSTRAP_RENDEZVOUS_DIST_DIR` points at nothing. | Run the dashboard build step; point the variable at the `dist/` directory it emits. |
| `looks like the dashboard source directory rather than its build output` | You pointed at `src/`, not at `dist/`. | Point at the build output. The source index references `/src/main.tsx`; a built one never does. |
| `which is not on disk` (naming a referenced asset) | The build is half-written or partly deleted. | Re-run the dashboard build. Do not serve it as-is; the browser would fetch an asset that answers `404`. |
| `is older than the source it came from` | The build predates the code, and `BOOTSTRAP_RENDEZVOUS_ALLOW_STALE_DIST` is not set. | Rebuild the dashboard, re-run the preflight, restart. The gate is working; this is the failure it exists to catch. |
| `which this service cannot type` | The build emitted a file extension the static server has no content type for. | Report it — the extension list needs an addition. Serving it would hand the browser an untyped file it silently declines to use. |
| `is required` (naming a variable) | A required variable is missing or empty. | Set it. The message names which one; there are three required. |
| `must be one of 1, true, 0 or false` | An opt-in flag has an unrecognised value, such as `yes`. | Use `1` or `0`. The strictness is deliberate: a typo must not silently leave a safeguard off. |
| `event=config-invalid` | Any of the above. The port was never bound. | Fix what the same line names. The previously running instance, if any, was never displaced. |
| Every upload answers `401` | The token here and the token in the authority app differ, or the header is missing. | Compare both halves. All authentication failures answer identically, so the response cannot tell you which. |
| An upload answers `413` | The body exceeded the configured ceiling. The response names the limit. | Raise `BOOTSTRAP_RENDEZVOUS_MAX_UPLOAD_BYTES` if the roll legitimately grew, and raise the proxy's body limit above it. |
| Every redemption answers `unknown` | Almost always a data directory that moved, or a restart against a different one. | Check `BOOTSTRAP_RENDEZVOUS_DATA_DIR` against what the previous instance used. Codes minted against the old directory are gone; mint new ones. |
| Nothing at all in the log | Expected. Production logging is fatal-only. | Set `BOOTSTRAP_RENDEZVOUS_DEV_LOGGING=1` and restart if you need per-request lines. |

---

## Verifying this document

The eight deployment steps above are not illustrations. `scripts/run-bootstrap-operator-smoke.sh`
extracts the fenced blocks **from this file** — not from a copy — and executes them in order against
a target whose dashboard build has been deleted, then asserts the behaviours this document claims:
same-origin serving, the bearer gate, the ceiling naming its limit, the always-`200` redemption
vocabulary, the reserved API prefix, the silent production default and the shape of development
logging, the non-loopback refusal, and the stale-build refusal followed by the documented recovery.

A step that cannot be extracted, or that fails when it is run, exits with a distinct code and is
reported as a **defect in this document**. If you had to improvise to get through the procedure
above, so would that script, and the fix belongs here — in this file — rather than in your notes.
