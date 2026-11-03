#!/usr/bin/env bash
# lean-part1.sh <run-dir> [with-khb] - lean hardware run, part 1 (2026-10-29): a fresh party "votetorrent" (the apps' PARTY_ID), the host
# officer founds n7, mints the join code, kh-a joins (kh-b too with with-khb: the dry run). Uses ../part1's leg.sh launch/ctl helpers and its
# h3_join_one unchanged. Leaves the peers stopped (part 2 reopens them in-process). Prints LEAN-P1: PASS|FAIL <token>.
# Needs VT_LEAN_RELAY_ENV (the relay.env file: RELAY_MULTIADDR, PEER_ID, LAN_IP). <run-dir> must be absolute and outside the repo (secrets).
LEAN="$(cd "$(dirname "$0")" && pwd)"
RD="$1"; WITH_KHB="${2:-}"
[ -n "$RD" ] || { echo "usage: $0 <run-dir> [with-khb]"; exit 2; }
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
LOGF="$PD/part1.log"
say () { printf '%s %s\n' "$(iso)" "$*" | tee -a "$LOGF"; }
fail () { say "LEAN-P1: FAIL $1"; for r in kh-b kh-a officer; do stop_peer "$r" >/dev/null 2>&1; done; exit 1; }

jq -n --arg r "$(relay_get PEER_ID)" '{partyId:"votetorrent", authorityId:null, relay:{peerId:$r}, networks:{}, roles:{}, sApp:{id:"org.votetorrent", version:"1.0.0"}}' > "$ST/party.json"; chmod 600 "$ST/party.json"
openssl rand -hex 16 > "$SEC/ctl.token"; chmod 600 "$SEC/ctl.token"
{ relay_get LAN_IP; relay_get RELAY_MULTIADDR; printf '%s\n' "$HOME"; cat "$SEC/ctl.token"; } > "$SEC/known.txt"; chmod 600 "$SEC/known.txt"
say "party votetorrent, relay $(relay_get PEER_ID | cut -c1-12)…"

# officer: fresh boot, circuit address, owner setup
mkdir -p "$ST/officer"; chmod 700 "$ST/officer"
say "officer boot: $(launch_peer officer 2>&1)" ; [ -s "$RUN/officer/ctl.port" ] || fail officer-boot
circ_ok () { ctlq "$1" readback | jq -e '.circuitViaRelay == true and .nonCircuitAddrs == 0' >/dev/null; }
poll_until 90 circ_ok officer || fail officer-relay-reservation
cap="$(ctlv officer capability | jq -r .capability)"; os="$(ctlv officer owner-setup)"; say "officer capability=$cap owner-setup=$(printf '%s' "$os" | jq -c .)"
printf '%s' "$os" | jq -e '.capabilityAfter == "ready" and .ownerIsIdentity == true' >/dev/null || fail owner-setup
jq --arg p "$(role_peer officer)" '.roles.officer = {peerId: $p}' "$ST/party.json" > "$ST/party.json.tmp" && mv "$ST/party.json.tmp" "$ST/party.json" && chmod 600 "$ST/party.json"

# found n7
r="$(ctlv officer found "$(jq -nc --arg n "${LEAN_NET_NAME:-Lean Network}" '{name:$n, key:"n7"}')")"; say "found n7: $(printf '%s' "$r" | jq -c 'del(.hashFull)')"
printf '%s' "$r" | jq -e '.ok == true and .attachCount == 1 and .attach.founder == true and .attach.intent == "founding"' >/dev/null || fail found
r="$(ctlv officer authority-id '{"networkKey":"n7"}')"; say "authority-id: $r"
printf '%s' "$r" | jq -e '.count == 1' >/dev/null || fail authority-id

# mint (multi-use: kh-a, kh-b/Redmi)
r="$(ctlv officer mint "$(jq -nc --arg c "$SEC/n7-code.txt" --arg f "$SEC/n7-fingerprint.txt" '{networkKey:"n7", codeFile:$c, fingerprintFile:$f}')")"; say "mint: $r"
printf '%s' "$r" | jq -e '.v == 2 and .memberAddrsCircuitOnly == true and .fingerprintEqual == true' >/dev/null || fail mint
cat "$SEC/n7-code.txt" >> "$SEC/known.txt"; printf '\n' >> "$SEC/known.txt"

# joins
h3_join_one kh-a h3-joins || fail "join-kh-a-$H3_TOKEN"
say "kh-a joined: $(tail -1 "$PD/h3-joins/join-kh-a.json" | jq -c '{outcome, admittedVia, joinMs}')"
if [ "$WITH_KHB" = with-khb ]; then
  h3_join_one kh-b h3-joins || fail "join-kh-b-$H3_TOKEN"
  say "kh-b joined: $(tail -1 "$PD/h3-joins/join-kh-b.json" | jq -c '{outcome, admittedVia, joinMs}')"
fi
for r in kh-b kh-a officer; do stop_peer "$r" || fail "stop-$r"; done
{ echo "RELAY_MULTIADDR=$(relay_get RELAY_MULTIADDR)"; echo "RELAY_PEER=$(relay_get PEER_ID)"; echo "LAN_IP=$(relay_get LAN_IP)"; echo "PARTY_STATE=$ST"; echo "S62=$S62"; } > "$RD/precheck.env"; chmod 600 "$RD/precheck.env"
say "LEAN-P1: PASS network=$(jq -r .networks.n7.hash "$ST/party.json" | cut -c1-8) authority=$(jq -r .authorityId "$ST/party.json" | cut -c1-8)"
