# vt_appattest_release_gate_test.rb — behavioral test for the D-14 machine-enforced
# release gate (scripts/fastlane/vt_appattest_release_gate.rb).
#
# WHY THIS EXISTS: the gate is `require`d by every real publish lane in
# apps/VoteTorrentAuthority/{android,ios}/fastlane/Fastfile, but nothing proved it
# actually *fires* — a gate nobody has ever seen turn red is not a gate, it's a comment.
#
# SEAM: this environment has Ruby 3.2.2 but does NOT have the `fastlane` gem installed
# (bundler can't resolve apps/VoteTorrentAuthority's Gemfile.lock offline-cached gems),
# so `FastlaneCore::UI` — the gate's only external dependency — is unavailable. Rather
# than reimplementing the gate's decision logic in a different language (which would
# prove nothing about THIS script), we `require` the real .rb file verbatim and supply a
# minimal double for the one external symbol it touches (`FastlaneCore::UI.user_error!` /
# `.success`). Every comparison, every regex extraction, every branch below runs the
# actual production Ruby.
#
# Run: ruby scripts/fastlane/vt_appattest_release_gate_test.rb
#
# This is intentionally a plain Ruby script using stdlib `minitest` (ships with Ruby,
# no Gemfile/bundle needed) — there is no established Ruby test convention elsewhere in
# this repo to mirror.

require "minitest/autorun"
require "fileutils"
require "tmpdir"

# --- Minimal double for the gate's ONLY external dependency ----------------------------
# Real FastlaneCore::UI.user_error! raises and aborts the Fastlane run; real .success
# prints and returns. We reproduce exactly that contract (raise vs. return) so the gate's
# fail-closed branches are observable as Ruby exceptions in a plain test process.
module FastlaneCore
  module UI
    class Error < StandardError; end

    class << self
      attr_accessor :last_success_message

      def user_error!(msg)
        raise Error, msg
      end

      def success(msg)
        self.last_success_message = msg
      end
    end
  end
end

GATE_PATH = File.expand_path("vt_appattest_release_gate.rb", __dir__)
require GATE_PATH

REPO_ROOT = File.expand_path("../..", __dir__)
ANDROID_FASTFILE = File.join(REPO_ROOT, "apps", "VoteTorrentAuthority", "android", "fastlane", "Fastfile")
IOS_FASTFILE     = File.join(REPO_ROOT, "apps", "VoteTorrentAuthority", "ios", "fastlane", "Fastfile")
VOTER_ANDROID_FASTFILE = File.join(REPO_ROOT, "apps", "VoteTorrentVoter", "android", "fastlane", "Fastfile")
VOTER_IOS_FASTFILE = File.join(REPO_ROOT, "apps", "VoteTorrentVoter", "ios", "fastlane", "Fastfile")

GENERATED_RELATIVE = File.join("apps", "VoteTorrentAuthority", "src", "engines", "appattest-keys.generated.ts")

class VtAppAttestReleaseGateTest < Minitest::Test
  def setup
    FastlaneCore::UI.last_success_message = nil
  end

  # --- helpers ---------------------------------------------------------------------

  def with_fixture_repo(app_id:, environment:)
    Dir.mktmpdir("vt-appattest-gate-") do |dir|
      generated_dir = File.dirname(File.join(dir, GENERATED_RELATIVE))
      FileUtils.mkdir_p(generated_dir)
      File.write(
        File.join(dir, GENERATED_RELATIVE),
        <<~TS
          // fixture, not the real file
          export const APPLE_APP_ID: string = '#{app_id}';
          export const APP_ATTEST_ENVIRONMENT: 'development' | 'production' = '#{environment}';
        TS
      )
      yield dir
    end
  end

  # Reads the block belonging to `lane :name do ... end` out of a Fastfile's raw text,
  # by depth-counting `do`/`end` tokens starting from the lane's opening line. Both real
  # Fastfiles under test have no additional nested `do` blocks inside their lane bodies
  # (verified by reading them), so a naive depth counter is sufficient and avoids
  # actually `require`-ing (and thereby *executing*) Fastlane DSL files that this
  # environment cannot run standalone.
  def lane_body(fastfile_text, lane_name)
    lines = fastfile_text.lines
    start_idx = lines.index { |l| l =~ /^\s*lane\s+:#{Regexp.escape(lane_name)}\s+do\s*$/ }
    refute_nil start_idx, "lane :#{lane_name} not found in Fastfile"
    depth = 1
    body = []
    i = start_idx + 1
    while i < lines.length && depth > 0
      line = lines[i]
      depth += line.scan(/\bdo\b/).size
      depth -= line.scan(/\bend\b/).size
      break if depth <= 0
      body << line
      i += 1
    end
    body.join
  end

  # --- RED: the gate must refuse every unshippable input ----------------------------

  def test_refuses_the_committed_free_personal_team_app_id
    with_fixture_repo(app_id: "94TY7UR2W5.org.votetorrent.voter", environment: "production") do |repo|
      err = assert_raises(FastlaneCore::UI::Error) do
        VtAppAttestReleaseGate.assert_releasable!(repo)
      end
      assert_match(/FREE PERSONAL TEAM/, err.message)
    end
  end

  def test_refuses_a_non_production_environment_even_with_a_good_app_id
    with_fixture_repo(app_id: "ABCDE12345.org.votetorrent.authority", environment: "development") do |repo|
      err = assert_raises(FastlaneCore::UI::Error) do
        VtAppAttestReleaseGate.assert_releasable!(repo)
      end
      assert_match(/APP_ATTEST_ENVIRONMENT/, err.message)
    end
  end

  def test_refuses_an_empty_app_id
    with_fixture_repo(app_id: "", environment: "production") do |repo|
      err = assert_raises(FastlaneCore::UI::Error) do
        VtAppAttestReleaseGate.assert_releasable!(repo)
      end
      assert_match(/empty/, err.message)
    end
  end

  def test_refuses_a_missing_generated_file
    Dir.mktmpdir("vt-appattest-gate-missing-") do |repo|
      err = assert_raises(FastlaneCore::UI::Error) do
        VtAppAttestReleaseGate.assert_releasable!(repo)
      end
      assert_match(/could not find/, err.message)
    end
  end

  def test_refuses_an_unparseable_generated_file
    Dir.mktmpdir("vt-appattest-gate-unparseable-") do |repo|
      generated_dir = File.dirname(File.join(repo, GENERATED_RELATIVE))
      FileUtils.mkdir_p(generated_dir)
      File.write(File.join(repo, GENERATED_RELATIVE), "// no exported consts at all\n")
      err = assert_raises(FastlaneCore::UI::Error) do
        VtAppAttestReleaseGate.assert_releasable!(repo)
      end
      assert_match(/could not find `export const/, err.message)
    end
  end

  # --- GREEN: the gate must pass a genuinely releasable config ---------------------

  def test_passes_a_paid_team_app_id_in_production
    with_fixture_repo(app_id: "ABCDE12345.org.votetorrent.authority", environment: "production") do |repo|
      VtAppAttestReleaseGate.assert_releasable!(repo)
      assert_match(/releasable/, FastlaneCore::UI.last_success_message)
    end
  end

  # --- Wiring: every real publish lane in both Fastfiles must call the gate FIRST --

  def test_android_build_apk_lane_calls_the_gate
    body = lane_body(File.read(ANDROID_FASTFILE), "build_apk")
    assert_match(/^[ \t]*VtAppAttestReleaseGate\.assert_releasable!\(REPO_ROOT\)/, body)
  end

  def test_android_build_aab_lane_calls_the_gate
    body = lane_body(File.read(ANDROID_FASTFILE), "build_aab")
    assert_match(/^[ \t]*VtAppAttestReleaseGate\.assert_releasable!\(REPO_ROOT\)/, body)
  end

  def test_ios_beta_lane_calls_the_gate
    body = lane_body(File.read(IOS_FASTFILE), "beta")
    assert_match(/^[ \t]*VtAppAttestReleaseGate\.assert_releasable!\(REPO_ROOT\)/, body)
  end

  def test_ios_release_lane_calls_the_gate
    body = lane_body(File.read(IOS_FASTFILE), "release")
    assert_match(/^[ \t]*VtAppAttestReleaseGate\.assert_releasable!\(REPO_ROOT\)/, body)
  end

  # Non-publish lanes must NOT be forced through the gate (they can't produce a
  # distributable artifact, so gating them would just slow down local iteration).
  def test_android_build_debug_lane_is_not_gated
    body = lane_body(File.read(ANDROID_FASTFILE), "build_debug")
    refute_match(/VtAppAttestReleaseGate/, body)
  end

  # The voter app embeds no APPLE_APP_ID at all (grep-verified), so its Fastfile is
  # deliberately not gated. Documented here, not "fixed" — the whole point of the
  # 51-VALIDATION.md note is that this exclusion is intentional.
  def test_voter_android_fastfile_does_not_require_the_gate
    text = File.read(VOTER_ANDROID_FASTFILE)
    refute_match(/vt_appattest_release_gate/, text)
  end

  # Closes the gap the Android case above left open: until now nothing would have caught
  # a Voter iOS Fastfile that wrongly required this gate, because no VOTER_IOS_FASTFILE
  # constant existed. The Voter is gated by its own team check
  # (scripts/fastlane/vt_team_gate.rb) instead, because the Voter embeds no
  # APPLE_APP_ID — the Authority embeds it and is the verifier that pins the Voter's
  # identity — so this gate would pass while proving nothing about the Voter's own team.
  def test_voter_ios_fastfile_does_not_require_the_gate
    text = File.read(VOTER_IOS_FASTFILE)
    refute_match(/vt_appattest_release_gate/, text)
  end
end
