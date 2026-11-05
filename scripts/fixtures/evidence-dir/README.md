# Evidence-dir checker fixtures

These files are the tests of `scripts/assert-evidence-dir.mjs`. They are inert on disk: no file here holds a
value that any checker rule matches. Every planted value exists only as a placeholder inside a case operation and
is built, from fragments, in a temporary directory while `--selftest` runs.

## Layout

- `base-host/` is a phase-dir-shaped tree: `64-WALL-GATE.md` and `64-evidence/` with the host layouts of the
  earlier plans (baselines, wall, owner-store-host, relay, dkg-host, host-voter, scanner-bundle). It passes as is.
- `base-device/` holds `64-device-evidence/`: the summary, the camera-gate layout on its legal retry path, one
  rehearsal session of three runs, and the replay results file. It passes as is, and `--streak 3` passes on it.
- `cases/<name>.json` is one case each. A `pass-*` case expects a pass. A `fail-<token>[--<variant>]` case expects
  exactly the one token named, and the self-test asserts that the set of distinct tokens equals that one token.

## Case file

A single JSON object with the keys `base` (`base-host` or `base-device`), an optional `args` array (extra
checker arguments such as the git flag or the streak flag), `ops` (an ordered array) and `expect` (`PASS` or a
token). An optional `expectAlso` array names extra tokens a `fail-*` case legitimately produces beside `expect`: the
self-test then requires the distinct token set to equal `expect` plus `expectAlso` exactly (no key keeps the
single-token rule). An optional `knownOverwrites` array (each `root`, `rel`, `beforeContent`, `afterContent`) adds
selftest-only known-overwrite entries for that case, matched by the git blob ids of the two contents, exactly like the
checker's built-in `KNOWN_OVERWRITES`. The checker is run on the case root, which holds the copied base plus the effect of the ops.

## Operations

Each op is an object with an `op` key. Paths are relative to the case root.

- `write` (`path`, `content`) and `append` (`path`, `content`).
- `delete` (`path`; a file or a directory) and `move` (`from`, `to`).
- `symlink` (`path`, `target`): the only way a link ever exists; no link is stored in this directory.
- `git-init`: initialise a repository in the case root and commit everything, with fixed identity, no signing, no
  hooks and no user or system config.
- `git-commit`: stage everything and commit with the same settings.
- `secrets-file` (`secret`): writes a secrets file next to the case root, outside it, and passes it to the
  checker as its single secrets-file argument.

## Placeholders

Written as the word PLANT with a kind, inside double braces, in an op's `content`. The materialiser replaces each one
with a synthetic string that is never a decodable code. The kinds, in words:

- Join codes: a first-version prefix, and a second-version prefix, each followed by a synthetic body.
- A cadre invitation prefix followed by a synthetic body.
- A JSON pair whose key is the invite private key name, with a synthetic value.
- A raw certificate chain: a long base64 DER run built from a repeated synthetic word.
- Inline image data: a data URL head followed by a short synthetic body.
- A vote needle in the tag-needle-id form.
- A known secret of forty characters, and a known window (sixteen characters taken from inside it).
- Device identifier pairs: a camelCase pair for the device evidence zone, and a PascalCase column pair for the host zone.
- Nonce pairs, in the same two forms.
- Attestation pairs: a statement pair with a long value, and a details column pair whose value is a JSON string.
- The raw capture wrapper of the association probe: version, probe id and a rows array.
- A tool-call markup tag.
- A phone data-clear command, as one pre-quoted remote adb string.
- A process-list command with the forbidden extended-regex flag.
- Four mention kinds that must PASS: a test title that merely names the join prefix, the invitation prefix with
  a trailing space, a sentence naming the invite private key word, and a code expression that assigns a probe
  token to the device id key.

## Adding a case

Add the file under `cases/`, name it for its token, and re-run `node scripts/assert-evidence-dir.mjs --selftest`.
The count in the final line is 71 case files plus the self-trip pass.

## The declared restart (notes 19 E7)

`--streak` accepts exactly one restart and nothing else: `run-1` with exactly `attempt-1` and `attempt-2`, an
attempt-level `attempt-2/reason.txt` of one line `RESTART notes-19-e7: <why>`, and an `attempt-1` with at least one
non-PASS leg. The streak then reads `run-1/attempt-2` (every leg PASS, the `--legs` list present) and the run summary.
Seven cases pin it: `pass-streak-restart` (accepted, with its `STREAK PASS k=3` line), `fail-streak-retried--restart-undeclared`
(a plain reason), `--restart-run-2` (the line on another run), `--restart-attempt-3` (the line on a third attempt),
`--restart-wrong-token` (another token), `--restart-attempt-1-pass` (over an all-PASS attempt-1; also reports
`retry-without-failure`, hence `expectAlso`) and `fail-streak-not-pass--restart-attempt-fail` (a declared restart whose
attempt-2 has a FAIL leg).

## The declared E12 chain (notes 19 E12, 64-55)

`--streak` also accepts exactly one longer chain and nothing else: `run-1` with exactly `attempt-1`, `attempt-2` and
`attempt-3`, `attempt-2/reason.txt` the one line `RESTART notes-19-e7: <why>`, `attempt-3/reason.txt` the one line
`RESTART notes-19-e12: <why>`, and `attempt-1` and `attempt-2` each with at least one non-PASS leg. The streak then
reads `run-1/attempt-3`. The E7 rule above is unchanged, so an e7 line on attempt-3 stays `streak-retried`
(`--restart-attempt-3`). Seven cases pin the chain: `pass-streak-restart-e12` (accepted, with its `STREAK PASS k=3`
line), `fail-streak-retried--e12-on-attempt-2` (the two reason tokens swapped), `--e12-without-e7` (a plain attempt-2
reason), `--e12-run-2` (the chain on another run), `--e12-attempt-4` (a fourth attempt after the chain),
`--e12-attempt-2-all-pass` (attempt-2 all PASS; also reports `retry-without-failure`, hence `expectAlso`) and
`fail-streak-not-pass--e12-attempt-3-fail` (the declared chain whose attempt-3 has a FAIL leg).

## The declared E15 chain (notes 19 E15, 64-56)

`--streak` also accepts exactly one longest chain and nothing else: `run-1` with exactly `attempt-1` to `attempt-4`,
`attempt-2/reason.txt` the e7 line, `attempt-3/reason.txt` the e12 line, `attempt-4/reason.txt` the one line
`RESTART notes-19-e15: <why>`, and `attempt-1`, `attempt-2` and `attempt-3` each with at least one non-PASS leg. The
streak then reads `run-1/attempt-4`. The E7 and E12 rules are unchanged (`--e12-attempt-4`, an e12 line on a fourth
attempt, stays `streak-retried`). Eight cases pin it: `pass-streak-restart-e15` (accepted, with its `STREAK PASS k=3`
line), `fail-streak-retried--e15-without-e12` (a plain attempt-3 reason), `--e15-on-attempt-3` (the line on a third
attempt), `--e15-run-2` (the chain on another run), `--e15-attempt-5` (a fifth attempt), `--e15-attempt-3-all-pass`
(attempt-3 all PASS; also reports `retry-without-failure`, hence `expectAlso`), `fail-streak-not-pass--e15-attempt-4-fail`
(the declared chain whose attempt-4 has a FAIL leg) and `pass-session-rewarm-section` (a session.md holding the n6
re-warm section's new `R1`-suffixed keys beside the base keys gives no finding).

## The declared E23 chain (notes 19 E23, 64-60)

`--streak` also accepts the E15 chain with its last reason line replaced: `run-1` with exactly `attempt-1` to `attempt-4`,
`attempt-2/reason.txt` the e7 line, `attempt-3/reason.txt` the e12 line, `attempt-4/reason.txt` one line
`RESTART notes-19-e23: <why>` (run 1 redone on a fresh party, the attempt-5 redo), and `attempt-1`, `attempt-2` and
`attempt-3` each with at least one non-PASS leg. The streak then reads `run-1/attempt-4`. The E7, E12 and E15 chains are
unchanged and there is no five-attempt branch (`--e23-attempt-5`, an e23 line on a fifth attempt after an e15 fourth,
stays `streak-retried`). Nine cases pin it: `pass-streak-restart-e23` (accepted, with its `STREAK PASS k=3` line),
`fail-streak-retried--e23-without-e12` (a plain attempt-3 reason), `--e23-on-attempt-3` (the line on a third attempt),
`--e23-run-2` (the chain on another run), `--e23-attempt-5`, `--e23-empty-why` (the line with no why),
`--e23-two-lines` (the line plus a second line; also reports `reason-missing`, hence `expectAlso`),
`--e23-attempt-3-all-pass` (attempt-3 all PASS; also reports `retry-without-failure`, hence `expectAlso`) and
`fail-streak-not-pass--e23-attempt-4-fail` (the declared chain whose attempt-4 has a FAIL leg). Only
`pass-streak-restart-e23` and `fail-streak-not-pass--e23-attempt-4-fail` read BAD before the change; the other seven were
already correct (a plain reason line never matched) and stay as pins.

## Known overwrites

`KNOWN_OVERWRITES` in the checker accepts one committed rewrite per entry, matched by evidence root, path and the
exact before and after blob ids. Three cases pin it: `pass-known-overwrite` (the exact rewrite is accepted),
`fail-evidence-overwritten--known-other-content` (same file, a different rewrite) and
`fail-evidence-overwritten--known-other-path` (the same rewrite listed for another file). Uncommitted overwrites are
never excepted. Entries are added only on the user's decision (the first: 64-53 reassert/leg.md, 2026-10-15).
