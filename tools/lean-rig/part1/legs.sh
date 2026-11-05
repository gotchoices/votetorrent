#!/usr/bin/env bash
# legs.sh - sourced after leg.sh (tools/lean-rig/part1; from plan 64-62's legs.sh, 2026-11-03): the one join leg lean-part1.sh uses
# (h3_join_one + h3_tag_wait) and its jq helpers, carried verbatim. The other H-legs of the plan 64-62 rehearsal were not carried.
jqe () { jq -e "$@" >/dev/null 2>&1; }
party () { jq -r "$1" "$ST/party.json"; }
role_peer () { cat "$ST/$1/peer-id.txt"; }

h3_join_one () { # <role> <leg>: echoes nothing; sets H3_TOKEN (empty on success); writes the HR5-BOOT-/HR5-JOIN- keys
  local role="$1" L="$2" up kk r rc off line n7h8 officerTag
  up="$(printf '%s' "$role" | tr a-z A-Z)"
  H3_TOKEN=""
  launch_peer "$role" >"$WORK/.h3-launch-$role" 2>&1; rc=$?
  ll "$L" "boot $role: $(cat "$WORK/.h3-launch-$role")"
  if [ "$rc" != 0 ]; then H3_TOKEN=boot; return 1; fi
  circ_ok () { ctlv "$role" readback | jq -e '.circuitViaRelay == true and .nonCircuitAddrs == 0' >/dev/null; }
  if ! poll_until 90 circ_ok; then H3_TOKEN=boot; return 1; fi
  kv "HR5-BOOT-$up" "recreated=false readyMs=$(sed -n 's/.*readyMs=\([0-9]*\).*/\1/p' "$WORK/.h3-launch-$role" | head -1) circuit=true nonCircuitAddrs=0"
  r="$(ctlv "$role" join "$(jq -nc --arg c "$SEC/n7-code.txt" --arg n "$(party '.networks.n7.name')" --arg f "$SEC/n7-fingerprint.txt" '{codeFile:$c, expectName:$n, expectFingerprintFile:$f}')")"; rc=$?
  printf '%s' "$r" | jq -c 'del(.recent0Hash)' >> "$PD/$L/join-$role.json"
  ll "$L" "join $role: $(printf '%s' "$r" | jq -c 'del(.recent0Hash)')"
  if printf '%s' "$r" | jq -e '.reason == "preview-mismatch" or .reason == "preview-malformed"' >/dev/null 2>&1; then H3_TOKEN=preview-mismatch; return 1; fi
  if printf '%s' "$r" | jq -e '.reason == "join-timeout"' >/dev/null 2>&1; then H3_TOKEN=join-timeout; return 1; fi
  if [ "$rc" != 0 ] || ! printf '%s' "$r" | jq -e '.ok == true' >/dev/null; then H3_TOKEN=join-outcome; return 1; fi
  printf '%s' "$r" | jq -e '.outcome == "joined" and .admittedVia == "redeemed"' >/dev/null || { H3_TOKEN=join-outcome; return 1; }
  printf '%s' "$r" | jq -e '.joinMs <= 420000' >/dev/null || { H3_TOKEN=join-timeout; return 1; }
  printf '%s' "$r" | jq -e '.attach.founder == false and .attach.intent == "joining"' >/dev/null || { H3_TOKEN=founder-flag; return 1; }
  n7h8="$(printf '%s' "$(party '.networks.n7.hash')" | cut -c1-8)"
  printf '%s' "$r" | jq -e --arg h "$n7h8" '.isJoinedNetwork == true and .recent0 == $h and .isSelfVouched == true' >/dev/null || { H3_TOKEN=same-network; return 1; }
  printf '%s' "$r" | jq -e '.hiddenOpenFailures == 0' >/dev/null || { H3_TOKEN=join-outcome; return 1; }
  # the owner set replicates after the join: wait (bounded 120 s) until its tag equals the officer's
  officerTag="$(ctlv officer readback | jq -r .ownerSetTag)"
  h3_tag_wait "$role" "$officerTag" || return 1
  local warn=absent
  if printf '%s' "$r" | jq -e '.trustSaved == false' >/dev/null; then warn=shown; fi
  kv "HR5-JOIN-$up" "outcome=joined admittedVia=redeemed joinMs=$(printf '%s' "$r" | jq -r .joinMs) founder=false intent=joining recent0=$n7h8 ownerTrust=ok ownerSetTag=$officerTag ownerSetEqual=true trustWarning=$warn nonCircuitAddrs=0 hiddenOpenFailures=0"
  # the role's full peer id into party.json
  local pid
  pid="$(role_peer "$role")"
  jq --arg r "$role" --arg p "$pid" '.roles[$r] = {peerId: $p}' "$ST/party.json" > "$ST/party.json.tmp" && mv "$ST/party.json.tmp" "$ST/party.json" && chmod 600 "$ST/party.json"
  return 0
}

# h3_tag_wait <role> <officer tag>: E30 (c): the owner-set tag wait (HR5_TAG_WAIT_S, default 120 s); a timeout is wait-timeout, never a pass-through.
h3_tag_wait () {
  local role="$1" tag="$2"
  tag_eq () { ctlq "$role" readback | jq -e --arg t "$tag" '.ownerSetTag == $t and .ownerTrust == "ok" and .nonCircuitAddrs == 0' >/dev/null; }
  if ! poll_until "${HR5_TAG_WAIT_S:-120}" tag_eq; then H3_TOKEN=wait-timeout; return 1; fi
  return 0
}
