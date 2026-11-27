# vt_appattest_release_gate.rb — the D-14 machine-enforced release gate.
#
# D-13 committed a FREE PERSONAL TEAM App ID (`94TY7UR2W5.org.votetorrent.voter`) into
# apps/VoteTorrentAuthority/src/engines/appattest-keys.generated.ts for a runnable proof.
# The accepted risk: a shipped authority binary carrying that value would treat builds
# signed under that personal team as the legitimate App Attest producer. D-14 is the
# required, non-optional mitigation — this gate fails any real publish lane while the
# committed constants are unshippable.
#
# Mirrors vt_signing.rb's "prove X before building" shape (see lane :verify_keystore):
# this reads a plain TEXT file — no ts-node, no Node execution, no build dependency — so
# it runs in a fraction of a second, before any expensive build step. A gate that only
# runs after the expensive work is a gate nobody will wait for twice.
#
# Fail-closed by construction: every branch below either raises via UI.user_error! or
# reaches the single UI.success at the end. There is no code path that silently returns
# without having checked both values.

module VtAppAttestReleaseGate
  UI = FastlaneCore::UI

  # The exact free-team value D-13 committed. Named as a constant (not inlined into the
  # comparison) so a future paid-team swap is a one-line greppable change, and so this
  # file itself documents which value is currently unshippable.
  PERSONAL_TEAM_APP_ID = "94TY7UR2W5.org.votetorrent.voter"

  GENERATED_FILE_RELATIVE = File.join(
    "apps", "VoteTorrentAuthority", "src", "engines", "appattest-keys.generated.ts"
  )

  # The 2026-08-25 todo this used to name was CLOSED on 2026-09-01 when the paid Team ID
  # `6849Q7KVP5` was swapped in and this gate began to clear. It moved to todos/completed/,
  # so pointing an error message at it would send a reader to a file describing a solved
  # problem. The successor tracks the one piece of iOS attestation debt that is left: no
  # attestation has yet been produced under the paid team.
  TODO_PATH = ".planning/todos/pending/2026-09-01-ios-appattest-paid-team-device-proof.md"

  # The one public entry point. Call this as the FIRST statement of any lane that
  # produces a distributable artifact.
  def self.assert_releasable!(repo_root)
    generated_path = File.join(repo_root, GENERATED_FILE_RELATIVE)
    unless File.exist?(generated_path)
      UI.user_error!(
        "vt_appattest_release_gate: could not find #{generated_path}.\n" \
        "An unparseable/missing App Attest config FAILS this gate — it never passes silently."
      )
    end

    text = File.read(generated_path)

    app_id = extract_const(text, "APPLE_APP_ID", generated_path)
    environment = extract_const(text, "APP_ATTEST_ENVIRONMENT", generated_path)

    if app_id == PERSONAL_TEAM_APP_ID
      UI.user_error!(
        "vt_appattest_release_gate: APPLE_APP_ID is still the FREE PERSONAL TEAM value\n" \
        "(#{PERSONAL_TEAM_APP_ID}), committed under D-13 for a runnable proof only.\n\n" \
        "A release build carrying this value would treat that personal team's builds as\n" \
        "the legitimate App Attest attestation producer — not shippable.\n\n" \
        "Context on why this value was ever committed, and the remaining debt:\n  #{TODO_PATH}\n\n" \
        "Fix: obtain a paid Apple Developer Program Team ID, update APPLE_APP_ID in\n  #{GENERATED_FILE_RELATIVE}\n" \
        "to the paid team's <teamId>.<bundleId>, and re-run this gate."
      )
    end

    if app_id.empty?
      UI.user_error!(
        "vt_appattest_release_gate: APPLE_APP_ID is empty in\n  #{GENERATED_FILE_RELATIVE}\n\n" \
        "An unprovisioned authority fail-closes every genuine device's attestation — also\n" \
        "not shippable. See #{TODO_PATH}."
      )
    end

    if environment != "production"
      UI.user_error!(
        "vt_appattest_release_gate: APP_ATTEST_ENVIRONMENT is #{environment.inspect}, not the\n" \
        "literal 'production' (D-15), in\n  #{GENERATED_FILE_RELATIVE}\n\n" \
        "A 'development' App Attest environment accepts sideloaded/debug builds; a release\n" \
        "build must never ship with it. Restore the literal 'production' value before\n" \
        "publishing."
      )
    end

    UI.success("vt_appattest_release_gate: APPLE_APP_ID=#{app_id} (not the personal-team value), APP_ATTEST_ENVIRONMENT='#{environment}' — releasable.")
  end

  # Extracts `export const <NAME> ... = '<value>'` (optionally typed, e.g.
  # `export const APP_ATTEST_ENVIRONMENT: 'development' | 'production' = 'production';`).
  # An unfindable export FAILS via UI.user_error! rather than returning a default —
  # fail-closed on an unparseable file, same discipline as the value checks above.
  def self.extract_const(text, name, path)
    match = text.match(/export\s+const\s+#{Regexp.escape(name)}\s*(?::[^=]+)?=\s*'([^']*)'/)
    if match.nil?
      UI.user_error!(
        "vt_appattest_release_gate: could not find `export const #{name} = '...'` in\n  #{path}\n\n" \
        "An unparseable config FAILS this gate — it never passes silently."
      )
    end
    match[1]
  end
end
