#!/usr/bin/env bash
# host-kh-join.sh <run-dir> <code-file> <network-name> (tools/lean-rig, 2026-11-23): the part-1 half of host-kh.ts for a network a
# DEVICE founded. No host officer: writes the party state, boots the kh-a part-1 peer on VT_LEAN_RELAY_ENV, joins it with the device
# officer's join code (the product join through hr5-peer's `join` verb), records the network hash in party.json (networks.n7), and
# stops the peer so host-kh.ts can reopen it. Prints HK-JOIN: PASS|FAIL <token>. Fingerprint: <run>/secrets/n7-fingerprint.txt must
# hold the fingerprint the officer device shows (the join refuses a mismatch); with HK_FP_FROM_CODE=1 it is derived from the code.
LEAN="$(cd "$(dirname "$0")" && pwd)"
RD="$1"; CODE="$2"; NAME="$3"
[ -n "$RD" ] && [ -s "$CODE" ] && [ -n "$NAME" ] || { echo "usage: $0 <run-dir> <code-file> <network-name>"; exit 2; }
case "$RD" in /*) ;; *) echo "REFUSE: <run-dir> must be absolute"; exit 2 ;; esac
case "$RD/" in "$(cd "$LEAN/../../.." && pwd)/"*) echo "REFUSE: <run-dir> is inside the repo (it holds secrets)"; exit 2 ;; esac
[ -s "${VT_LEAN_RELAY_ENV:-}" ] || { echo "REFUSE: VT_LEAN_RELAY_ENV does not name a relay.env file"; exit 2; }
. "$LEAN/links.sh"
[ -e "$RD/state/party.json" ] && { echo "REFUSE: $RD/state/party.json exists"; exit 3; }
mkdir -p "$RD/state" "$RD/run" "$RD/secrets" "$RD/part-1/h3-joins"; chmod 700 "$RD/state" "$RD/run" "$RD/secrets"
export HR5_PD="$RD/part-1" HR5_ST="$RD/state" HR5_RUN_ROOT="$RD/run" HR5_SEC="$RD/secrets" HR5_WORK="$RD/part-1"
. "$LEAN/../part1/leg.sh"
. "$S62/legs.sh"
: > "$PD/commands.log"; : > "$WORK/keys.txt"
LOGF="$PD/host-kh-join.log"
say () { printf '%s %s\n' "$(iso)" "$*" | tee -a "$LOGF"; }
fail () { say "HK-JOIN: FAIL $1"; stop_peer kh-a >/dev/null 2>&1; exit 1; }
cp "$CODE" "$SEC/n7-code.txt"; chmod 600 "$SEC/n7-code.txt"
if [ "${HK_FP_FROM_CODE:-}" = 1 ]; then
  ( cd "$REPO/packages/vote-engine" && env -u NODE_OPTIONS TS_NODE_PROJECT=./tsconfig.test.json node --import ./register-ts-node.mjs --experimental-specifier-resolution=node \
    -e "const fs = await import('node:fs'); const rn = await import('@votetorrent/vote-engine/rn'); const d = rn.decodeNetworkJoinCode(fs.readFileSync('$SEC/n7-code.txt','utf8').trim()); if (!d.ok) { console.error('decode failed'); process.exit(1) } fs.writeFileSync('$SEC/n7-fingerprint.txt', d.fingerprint + '\n', { mode: 0o600 }); console.log('fingerprint ' + d.fingerprint + ' name-equal=' + (d.code.name === process.argv[1]))" --input-type=module "$NAME" ) || fail fingerprint
fi
[ -s "$SEC/n7-fingerprint.txt" ] || fail no-fingerprint
jq -n --arg r "$(relay_get PEER_ID)" --arg n "$NAME" '{partyId:"votetorrent", authorityId:null, relay:{peerId:$r}, networks:{n7:{name:$n}}, roles:{}, sApp:{id:"org.votetorrent", version:"1.0.0"}}' > "$ST/party.json"; chmod 600 "$ST/party.json"
openssl rand -hex 16 > "$SEC/ctl.token"; chmod 600 "$SEC/ctl.token"
say "party votetorrent, relay $(relay_get PEER_ID | cut -c1-12)..., network \"$NAME\""
say "kh-a boot: $(launch_peer kh-a 2>&1)"; [ -s "$RUN/kh-a/ctl.port" ] || fail boot
circ_ok () { ctlq kh-a readback | jq -e '.circuitViaRelay == true and .nonCircuitAddrs == 0' >/dev/null; }
poll_until 90 circ_ok || fail relay-reservation
r="$(ctlv kh-a join "$(jq -nc --arg c "$SEC/n7-code.txt" --arg n "$NAME" --arg f "$SEC/n7-fingerprint.txt" '{codeFile:$c, expectName:$n, expectFingerprintFile:$f}')")"
printf '%s' "$r" | jq -c 'del(.recent0Hash)' >> "$PD/h3-joins/join-kh-a.json"
say "join kh-a: $(printf '%s' "$r" | jq -c 'del(.recent0Hash)')"
printf '%s' "$r" | jq -e '.outcome == "joined"' >/dev/null || fail "join-$(printf '%s' "$r" | jq -r '.reason // "outcome"')"
h="$(printf '%s' "$r" | jq -r .recent0Hash)"
jq --arg h "$h" --arg p "$(role_peer kh-a)" '.networks.n7.hash = $h | .roles["kh-a"] = {peerId: $p}' "$ST/party.json" > "$ST/party.json.tmp" && mv "$ST/party.json.tmp" "$ST/party.json" && chmod 600 "$ST/party.json"
stop_peer kh-a || fail stop
say "HK-JOIN: PASS network=$(printf '%s' "$h" | cut -c1-8) joinMs=$(printf '%s' "$r" | jq -r .joinMs)"
