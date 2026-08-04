# Shared signing/build helpers for both VoteTorrent apps' fastlane lanes.
#
# Both apps' keys live in ONE keystore, so the store path and store password are
# shared and only the key alias/password are per-app:
#
#   STORE_FILE_VOTETORRENT      path to the shared keystore (~ expanded here)
#   PASSWORD_STORE_VOTETORRENT  keystore password
#   PASSWORD_KEY_<APP>          password for this app's key
#   KEY_ALIAS_<APP>             optional alias override
#
# Nothing here injects gradle signing properties — the release signingConfig in
# each app/build.gradle reads the same env vars directly, so a plain
# `./gradlew assembleRelease` with the same environment produces the same artifact.

require "json"

module VtSigning
  UI = FastlaneCore::UI

  class App
    attr_reader :name, :key_password_var, :key_alias_var, :default_alias,
                :android_dir, :app_dir, :repo_root

    def initialize(name:, default_alias:, android_dir:, app_dir:, repo_root:)
      @name = name
      @key_password_var = "PASSWORD_KEY_#{name.upcase}"
      @key_alias_var = "KEY_ALIAS_#{name.upcase}"
      @default_alias = default_alias
      @android_dir = android_dir
      @app_dir = app_dir
      @repo_root = repo_root
    end

    # Reads the signing vars, normalizes the keystore path to an absolute one,
    # and proves BOTH passwords against the keystore before any build starts.
    def resolve_signing_config
      raw_store = ENV["STORE_FILE_VOTETORRENT"].to_s.strip
      store_password = ENV["PASSWORD_STORE_VOTETORRENT"].to_s
      key_password = ENV[key_password_var].to_s
      key_alias = ENV[key_alias_var].to_s.strip
      key_alias = default_alias if key_alias.empty?

      missing = []
      missing << "STORE_FILE_VOTETORRENT (path to the shared VoteTorrent keystore)" if raw_store.empty?
      missing << "PASSWORD_STORE_VOTETORRENT (keystore password)" if store_password.empty?
      missing << "#{key_password_var} (password for the #{key_alias} key)" if key_password.empty?
      unless missing.empty?
        UI.user_error!("Missing signing environment variable(s):\n  - #{missing.join("\n  - ")}\n\nSee apps/VoteTorrentAuthority/BUILD-RELEASE.md.")
      end

      # Gradle's file() does not expand ~ and resolves relative paths against
      # android/app, while fastlane's cwd is android/. Normalizing to an absolute
      # path here and re-exporting it removes that whole class of mismatch.
      store_file = File.expand_path(raw_store)
      unless File.exist?(store_file)
        UI.user_error!("Keystore not found at #{store_file}\n(STORE_FILE_VOTETORRENT was #{raw_store.inspect})")
      end

      store_type = verify_credentials(store_file, store_password, key_alias, key_password)

      { store_file: store_file, store_password: store_password,
        key_alias: key_alias, key_password: key_password, store_type: store_type }
    end

    # Validates, then re-exports the normalized keystore path so the gradle
    # subprocess reads exactly what was checked.
    def apply_signing_env!
      config = resolve_signing_config
      ENV["STORE_FILE_VOTETORRENT"] = config[:store_file]
      ENV[key_alias_var] = config[:key_alias]
      UI.success("Signing with alias #{config[:key_alias]} from #{config[:store_file]}")
      config
    end

    # Delegates to scripts/VerifyKeystore.java, which drives the same KeyStore
    # API the Android Gradle Plugin uses. See that file for why keytool cannot
    # be used here. Returns the keystore type.
    def verify_credentials(store_file, store_password, key_alias, key_password)
      probe = VtSigning.run_quietly(
        [VtSigning.resolve_java, File.join(repo_root, "scripts", "VerifyKeystore.java"), store_file, key_alias],
        env: { "VT_STORE_PW" => store_password, "VT_KEY_PW" => key_password }
      )
      facts = probe[:output].scan(/^([A-Z_]+)=(.*)$/).to_h

      if facts["TYPE"].nil?
        UI.error(probe[:output])
        UI.user_error!("Could not inspect #{store_file}.")
      end

      if facts["STORE_OK"] != "1"
        UI.error(facts["ERROR"].to_s)
        UI.user_error!("Could not open the keystore — PASSWORD_STORE_VOTETORRENT is wrong, or #{store_file} is not a keystore.")
      end

      if facts["ALIAS_OK"] != "1"
        present = facts["ALIASES"].to_s
        UI.error("Aliases present in #{store_file}: #{present.empty? ? '(none)' : present.split(',').join(', ')}")
        UI.user_error!("Alias #{key_alias.inspect} is not in the keystore. Set #{key_alias_var} to the right one.")
      end

      return facts["TYPE"] if facts["KEY_OK"] == "1"

      # A keytool-created PKCS12 never has a per-key password: keytool discards
      # -keypass and encrypts the key with the STORE password instead. Such a
      # store is not broken — the intended key password was dropped at creation.
      if facts["KEY_OPENS_WITH_STORE_PW"] == "1"
        UI.user_error!(
          "The #{key_alias} key in #{store_file}\n" \
          "is encrypted with the STORE password, not the value in #{key_password_var}.\n\n" \
          "This is normal for a PKCS12 keystore made with keytool: keytool refuses to set a\n" \
          "per-key password and silently substitutes the store password (JDK-8008292, Won't Fix).\n\n" \
          "Fix: set #{key_password_var} to the same value as PASSWORD_STORE_VOTETORRENT.\n" \
          "(Multiple keys in one keystore are fine — that is not the constraint.)"
        )
      end

      UI.error(facts["KEY_ERROR"].to_s)
      UI.user_error!("#{key_password_var} is wrong for alias #{key_alias.inspect} (the store password opened the keystore, so only the key password is at fault).")
    end

    # node_modules and packages/*/dist are both gitignored, so a fresh clone
    # builds fine in debug (Metro serves from source) but fails during the
    # release bundle step. Catch it here rather than 15 minutes into gradle.
    def require_workspace!
      problems = []
      problems << "node_modules/ is missing" unless Dir.exist?(File.join(repo_root, "node_modules"))

      # Only packages that actually compile need a dist/ — the rest (e.g.
      # attestation-native) are consumed straight from src/ by Metro.
      Dir.glob(File.join(repo_root, "packages", "*", "package.json")).sort.each do |manifest|
        next unless JSON.parse(File.read(manifest)).dig("scripts", "build")
        pkg_dir = File.dirname(manifest)
        next if Dir.exist?(File.join(pkg_dir, "dist"))
        problems << "packages/#{File.basename(pkg_dir)}/dist is missing"
      end
      return if problems.empty?

      UI.user_error!(
        "The workspace is not built:\n  - #{problems.join("\n  - ")}\n\n" \
        "Run `fastlane android prepare`, or from the repo root:\n" \
        "  yarn install\n" \
        "  yarn workspaces foreach -At --include 'packages/*' run build"
      )
    end

    def artifact_path(relative)
      File.join(android_dir, "app", "build", "outputs", relative)
    end

    # A release build with no signing env: identical Metro production bundle and
    # Hermes compile, signed with the committed debug key. Installable and
    # testable, but a different app identity, so never publishable.
    def warn_if_signing_env_present!
      return if ENV["STORE_FILE_VOTETORRENT"].to_s.strip.empty?
      UI.important("STORE_FILE_VOTETORRENT is set, but this lane deliberately builds with the DEBUG key.")
      UI.important("Use `build_apk` if you meant to sign with the real key.")
    end

    def report(path, label, verify_release_signature:)
      UI.user_error!("Build reported success but #{path} does not exist.") unless File.exist?(path)

      signer = verify_release_signature ? VtSigning.verify_apk_signer(path) : nil
      size_mb = (File.size(path) / 1024.0 / 1024.0).round(1)

      UI.important("")
      UI.important("📱 #{label} BUILT")
      UI.important("------------------------------------------")
      UI.important("File:  #{path}")
      UI.important("Size:  #{size_mb} MB")
      UI.important("Signer SHA-256: #{signer}") if signer
      UI.important("Install: adb install -r #{path}")
      UI.important("------------------------------------------")
      path
    end
  end

  # Runs a command without echoing it, passing secrets through the environment
  # rather than argv so they never surface in `ps` or the fastlane log.
  def self.run_quietly(argv, env: {})
    output = IO.popen(env, argv, err: [:child, :out], &:read)
    { success: $?.success?, output: output.to_s }
  rescue Errno::ENOENT => e
    { success: false, output: e.message }
  end

  # JDK 11+ is required for `java Foo.java` single-file source launch.
  def self.resolve_jdk_tool(name)
    if ENV["JAVA_HOME"] && File.executable?(File.join(ENV["JAVA_HOME"], "bin", name))
      return File.join(ENV["JAVA_HOME"], "bin", name)
    end
    if File.executable?("/usr/libexec/java_home")
      home = `/usr/libexec/java_home 2>/dev/null`.strip
      return File.join(home, "bin", name) if !home.empty? && File.executable?(File.join(home, "bin", name))
    end
    return name if system("command -v #{name} > /dev/null 2>&1")
    UI.user_error!("#{name} not found. Install JDK 17 and set JAVA_HOME.")
  end

  def self.resolve_java
    resolve_jdk_tool("java")
  end

  # Last line of defence: a blank password env var must never yield a silently
  # debug-signed "release" APK, because that would be a different app identity.
  def self.verify_apk_signer(apk)
    apksigner = resolve_apksigner
    return nil unless apksigner

    result = run_quietly([apksigner, "verify", "--print-certs", apk])
    unless result[:success]
      UI.error(result[:output])
      UI.user_error!("apksigner could not verify #{apk}")
    end
    if result[:output].include?("CN=Android Debug")
      UI.user_error!("#{apk} is signed with the DEBUG certificate — refusing to call this a release build.")
    end
    result[:output][/SHA-256 digest:\s*(\S+)/i, 1]
  end

  def self.resolve_apksigner
    sdk = ENV["ANDROID_HOME"] || ENV["ANDROID_SDK_ROOT"] || File.expand_path("~/Library/Android/sdk")
    candidates = Dir.glob(File.join(sdk, "build-tools", "*", "apksigner")).select { |p| File.executable?(p) }
    if candidates.empty?
      UI.important("apksigner not found under #{sdk}/build-tools — skipping signature verification.")
      return nil
    end
    candidates.max_by do |p|
      begin
        Gem::Version.new(File.basename(File.dirname(p)))
      rescue ArgumentError
        Gem::Version.new("0")
      end
    end
  end
end
