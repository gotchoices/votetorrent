#!/usr/bin/env bash
#
# scripts/lib/logcat-wait.sh — shared logcat wait/poll helper for the Phase 17
# proof scripts (run-vtest02.sh, run-dial-probe.sh).
#
# IN-21 (17-REVIEW): this logic previously existed as four near-verbatim copies
# (marker wait + verdict poll in each script). The WR-22 status-capture fix and
# its WR-23 follow-up each had to land in four places — this file is the single
# home for that logic now.
#
# Not executable on its own — source it AFTER `set -euo pipefail` and AFTER
# anchoring the cwd to the repo root:
#   . scripts/lib/logcat-wait.sh

# wait_for_logcat_line PATTERN TIMEOUT_S LOG_PREFIX WHAT [ADB_DEVICE]
#
#   PATTERN    — extended regex passed to `adb logcat -e` / `grep`
#   TIMEOUT_S  — max seconds to wait for a matching line
#   LOG_PREFIX — script tag for error messages (e.g. "[vtest02]")
#   WHAT       — human label for error messages (e.g. "marker", "verdict")
#   ADB_DEVICE — optional ADB device selector (e.g. "-s emulator-5554"); defaults
#                to empty (uses the default ADB device — backward-compatible)
#
# Prints the first matching logcat line to stdout (empty if none arrived
# within TIMEOUT_S — the caller distinguishes timeout from match by testing
# the captured value). Returns 1 (after an error message on stderr) only when
# adb itself failed, so `LINE=$(wait_for_logcat_line ...)` aborts a `set -e`
# caller on device failure.
#
# Portability: prefers GNU timeout, then gtimeout (Homebrew coreutils), then a
# bounded 5 s-interval poll loop (macOS hosts without coreutils).
wait_for_logcat_line() {
  local pattern="$1" timeout_s="$2" prefix="$3" what="$4" adb_dev="${5:-}"
  local line="" status=0 timeout_bin elapsed

  timeout_bin=$(command -v timeout || command -v gtimeout || true)

  if [ -n "${timeout_bin}" ]; then
    # WR-22 (17-REVIEW): capture the timeout/adb pipeline status instead of a
    # blanket `|| true` so a device disconnect / immediate adb death is
    # reported as such, not blamed on a Metro rebundle or a timeout window
    # that never ran. `exit "${PIPESTATUS[0]}"` propagates the timeout/adb
    # status out of the substitution (head's own status is useless — it is 0
    # even when adb dies). Status 124 = window elapsed (normal no-match path,
    # handled by the caller); 141 (SIGPIPE after head matched) accompanies a
    # NON-empty capture and is fine.
    #
    # IN-19 (17-REVIEW) — known latency: head exits on the first match, but
    # the command substitution only returns when adb dies — via SIGPIPE on its
    # NEXT matching write, or at the end of the timeout window on a quiet
    # logcat. A successful capture can therefore stall up to the full window
    # AFTER the target line was matched. Accepted: the capture is still
    # correct, only slower; killing adb eagerly would complicate this helper.
    # SPIKE-073: `adb logcat -e PATTERN` emits its buffer-header separator lines
    # ("--------- beginning of main") REGARDLESS of the filter, so on current
    # platform-tools `head -1` captured the separator instead of the match. Every
    # marker wait then "matched" instantly and returned garbage — run-replication-proof.sh
    # launched both drones with STRAND_ID='---------', i.e. hosting a DIFFERENT strand
    # than the emulators, and the run measured nothing. Silent, and indistinguishable
    # from a healthy fast match. Drop the separators before head; --line-buffered keeps
    # the streaming branch's first-match latency unchanged.
    set +e
    line=$("${timeout_bin}" "${timeout_s}" adb ${adb_dev} logcat -e "${pattern}" | grep --line-buffered -v '^--------- ' | head -1; exit "${PIPESTATUS[0]}")
    status=$?
    set -e
    if [ -z "${line}" ] && [ "${status}" -ne 124 ]; then
      echo "${prefix} ERROR: adb logcat exited abnormally (status ${status}) before the ${timeout_s}s ${what} window elapsed — check device connection (adb devices)" >&2
      return 1
    fi
  else
    # Fallback: bounded poll loop (same cap, 5 s intervals) — macOS without coreutils.
    elapsed=0
    while [ "${elapsed}" -lt "${timeout_s}" ]; do
      # WR-22: an adb failure here previously degraded to silently polling nothing.
      set +e
      line=$(adb ${adb_dev} logcat -d | grep -v '^--------- ' | grep "${pattern}" | head -1; exit "${PIPESTATUS[0]}")
      status=$?
      set -e
      # WR-23 (17-REVIEW): only fatal when the capture is EMPTY — mirrors the
      # streaming branch. When the pattern matches early in a large dump, head
      # exits first and adb dies of SIGPIPE (status 141) AFTER the line was
      # successfully captured; that is not a device failure.
      if [ -z "${line}" ] && [ "${status}" -ne 0 ]; then
        echo "${prefix} ERROR: adb logcat -d failed (status ${status}) while polling for the ${what} — check device connection (adb devices)" >&2
        return 1
      fi
      if [ -n "${line}" ]; then break; fi
      sleep 5
      elapsed=$((elapsed + 5))
    done
  fi

  printf '%s\n' "${line}"
  return 0
}
