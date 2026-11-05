# vt_team_gate.rb — the D-09 team-consistency gate.
#
# This is D-09, and it is a SEPARATE gate from vt_appattest_release_gate.rb (D-14) — on
# purpose, never a reuse/rename/extension of it. vt_appattest_release_gate_test.rb:194-200
# (test_voter_android_fastfile_does_not_require_the_gate) pins that the Voter's Fastfile
# must NOT reference vt_appattest_release_gate, because the Voter embeds no APPLE_APP_ID —
# the Authority embeds it, and the Authority is the verifier that pins the Voter's
# identity. Reusing D-14's gate on the Voter would pass while proving nothing about the
# Voter's own team. Do not merge or rename these two gates.
#
# This is a POSITIVE match, not a negative one. `eeacd0d8`'s own commit message names the
# residual risk the paid-team swap left behind: a MISTYPED team id would reject every
# genuine iPhone while every existing gate stayed green, because the only existing check
# (vt_appattest_release_gate) asserts "not the old personal team" — a negative match that a
# typo sails straight through undetected. This gate asserts equality with the expected
# value instead, so a typo is caught, not merely a known-bad value.
#
# Like its sibling, this reads plain TEXT with a regex — no `xcodeproj` gem, no Node, no
# build dependency — so it runs in a fraction of a second, before any expensive build step.
#
# Fail-closed by construction: every branch below either raises via UI.user_error! or
# reaches the single UI.success at the end. There is no code path that silently returns
# without having checked every condition.

module VtTeamGate
  UI = FastlaneCore::UI

  # The paid team `DEVELOPMENT_TEAM` is expected to carry in both the Voter app target's
  # Debug and Release XCBuildConfiguration blocks. Named as a constant (not inlined into
  # the comparison) so a future team swap is a one-line greppable change.
  EXPECTED_TEAM_ID = "6849Q7KVP5"

  # The OLD free personal team. Named ONLY so a mismatch's error message can say "this is
  # the old personal team" instead of a generic value-mismatch — it is never itself the
  # basis of the pass/fail decision; equality with EXPECTED_TEAM_ID is.
  PERSONAL_TEAM_ID = "94TY7UR2W5"

  VOTER_PBXPROJ_RELATIVE = File.join(
    "apps", "VoteTorrentVoter", "ios", "VoteTorrentVoter.xcodeproj", "project.pbxproj"
  )

  GENERATED_FILE_RELATIVE = File.join(
    "apps", "VoteTorrentAuthority", "src", "engines", "appattest-keys.generated.ts"
  )

  # The one public entry point. Call this as the FIRST statement of the Voter's iOS `beta`
  # and `release` lanes.
  def self.assert_team!(repo_root)
    pbxproj_path = File.join(repo_root, VOTER_PBXPROJ_RELATIVE)
    unless File.exist?(pbxproj_path)
      UI.user_error!(
        "vt_team_gate: could not find #{pbxproj_path}.\n" \
        "A missing project file FAILS this gate — it never passes silently."
      )
    end

    text = File.read(pbxproj_path)

    # Quote-tolerant on purpose: a blanked-out `DEVELOPMENT_TEAM = "";` must be captured as
    # an empty value and REJECTED below, not silently skipped as "no match" — a regex that
    # stops matching is exactly the fail-open failure mode this gate exists to avoid.
    #
    # Line-anchored on purpose: unanchored, a commented-out `/* DEVELOPMENT_TEAM = X; */`
    # counted as a real assignment. With the SAME value on both, a live Debug entry plus a
    # commented Release entry gave matches.length == 2 and uniq.length == 1 — clearing both
    # guards below and PASSING, while only one config actually carried a team. That is
    # precisely the drift this gate exists to catch. `[ \t]` not `\s`: Ruby's `\s` matches
    # newlines, which would let `^` anchor on a preceding line and scan across into this
    # one, reopening the hole. Covered by the commented-out fixtures in the test file.
    matches = text.scan(/^[ \t]*DEVELOPMENT_TEAM\s*=\s*"?([^;"\s]*)"?\s*;/).flatten

    if matches.length < 2
      UI.user_error!(
        "vt_team_gate: found only #{matches.length} `DEVELOPMENT_TEAM` assignment(s) in\n" \
        "  #{pbxproj_path}\n\n" \
        "The app target's Debug AND Release XCBuildConfiguration blocks must each carry the\n" \
        "setting — one config silently losing it is exactly the drift case this gate exists\n" \
        "to catch."
      )
    end

    if matches.uniq.length > 1
      UI.user_error!(
        "vt_team_gate: DEVELOPMENT_TEAM values disagree in\n  #{pbxproj_path}\n\n" \
        "Found: #{matches.uniq.join(', ')}\n\n" \
        "Debug and Release disagreeing means one config would sign under the wrong team."
      )
    end

    team = matches.first
    if team.nil? || team.empty?
      UI.user_error!(
        "vt_team_gate: DEVELOPMENT_TEAM is empty in\n  #{pbxproj_path}\n\n" \
        "An empty team id fail-closes every genuine device — not shippable."
      )
    end

    if team == PERSONAL_TEAM_ID
      UI.user_error!(
        "vt_team_gate: DEVELOPMENT_TEAM is #{team}, the OLD FREE PERSONAL TEAM, in\n" \
        "  #{pbxproj_path}\n\n" \
        "App Attest is unavailable under the personal team. Expected the paid team\n" \
        "#{EXPECTED_TEAM_ID}."
      )
    end

    if team != EXPECTED_TEAM_ID
      UI.user_error!(
        "vt_team_gate: DEVELOPMENT_TEAM is #{team}, expected #{EXPECTED_TEAM_ID}, in\n" \
        "  #{pbxproj_path}\n\n" \
        "A mistyped-but-well-formed team id rejects every genuine iPhone while producing no\n" \
        "other visible symptom — this positive-match check exists precisely to catch that."
      )
    end

    generated_path = File.join(repo_root, GENERATED_FILE_RELATIVE)
    unless File.exist?(generated_path)
      UI.user_error!(
        "vt_team_gate: could not find #{generated_path}.\n" \
        "A missing App Attest config FAILS this gate — it never passes silently."
      )
    end

    generated_text = File.read(generated_path)
    app_id = extract_apple_app_id(generated_text, generated_path)
    prefix = app_id.split(".").first

    if app_id.empty? || prefix.nil? || prefix.empty?
      UI.user_error!(
        "vt_team_gate: APPLE_APP_ID is empty or has no team prefix in\n  #{generated_path}\n\n" \
        "An unparseable/empty Authority app id FAILS this gate — it never passes silently."
      )
    end

    if prefix != team
      UI.user_error!(
        "vt_team_gate: team prefix mismatch.\n\n" \
        "  #{pbxproj_path}\n    DEVELOPMENT_TEAM = #{team}\n\n" \
        "  #{generated_path}\n    APPLE_APP_ID = #{app_id} (team prefix #{prefix})\n\n" \
        "The Authority is the verifier that pins the Voter's identity — a divergence here\n" \
        "means the authority would reject the voter it is supposed to accept."
      )
    end

    UI.success("vt_team_gate: DEVELOPMENT_TEAM=#{team} is consistent with the Authority's APPLE_APP_ID=#{app_id}.")
  end

  # Own implementation, NOT a call into VtAppAttestReleaseGate.extract_const — see the
  # plan's <critical_framing>. Duplicating this four-line regex costs far less than
  # putting vt_appattest_release_gate's name into the Voter's dependency chain via a
  # transitive require.
  def self.extract_apple_app_id(text, path)
    match = text.match(/export\s+const\s+APPLE_APP_ID\s*(?::[^=]+)?=\s*'([^']*)'/)
    if match.nil?
      UI.user_error!(
        "vt_team_gate: could not find `export const APPLE_APP_ID = '...'` in\n  #{path}\n\n" \
        "An unparseable config FAILS this gate — it never passes silently."
      )
    end
    match[1]
  end
end
