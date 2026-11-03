# VoteTorrent Maestro suite

One shared set of [Maestro](https://maestro.dev) UI journeys for the two React Native apps,
`apps/VoteTorrentVoter` (`org.votetorrent.voter`) and `apps/VoteTorrentAuthority`
(`org.votetorrent.authority`). Every developer and every agent runs the same flows the same way:
`maestro/scripts/run.sh`. Do not write one-off adb or uiautomator tap scripts for a journey that is
covered here. Add or fix a flow instead.

> **Validation status (2026-11-03): none of these flows has run on a device yet.** They were written
> against the app source, and `maestro check-syntax` passes on every file. The emulator run was
> paused because a two-phone session needed Metro and the host. Treat each flow as unvalidated until
> it shows `PASS` in a `run.sh` summary. Record results in the table at the end of this file.

## Layout

```
maestro/
  config.yaml              workspace config for `maestro test maestro/` (excludes multi-device)
  voter/                   Voter journeys (single device, DEBUG build, dev seed)
  authority/               Authority journeys (single device, DEBUG build)
  multi-device/            per-device steps of the cross-device journeys (need a network peer)
  subflows/common|voter|authority   reusable pieces: launch, tabs, dev clock, forms, signing setup
  scripts/run.sh           the runner: device prep, Metro check, fingerprint helper, ordered runs
  scripts/run-multi-device.sh   sequences the multi-device steps
  scripts/biometric-autotouch.sh  answers emulator BiometricPrompts with `adb emu finger touch 1`
  scripts/lib.sh, run-config.yaml  runner internals
  patches/authority-testids.patch  testIDs (and a yarn script) for the Authority; see below
```

**Why one top-level `maestro/` folder rather than `apps/*/.maestro/`?**
- Both apps share the runner, the device prep, the fingerprint helper, the LogBox handling and this
  README.
- The cross-device journeys span both apps, so they belong to neither.
- Neither app's Metro or Jest config picks this folder up.
- It is not a yarn workspace. It has no `package.json` and adds no dependencies.

## 1. Install (once per machine)

**JDK.** Maestro needs Java 17+. Check with `java -version`. This Mac has Zulu 17 on PATH. With no
JDK on PATH, `run.sh` falls back to Android Studio's bundled JBR. You can also point to it yourself:

```sh
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
```

**Maestro CLI.** Run the official installer. It installs into `~/.maestro`:

```sh
curl -fsSL "https://get.maestro.mobile.dev" | bash
export PATH="$PATH:$HOME/.maestro/bin"   # the installer also appends this to ~/.zshrc and ~/.bash_profile
maestro --version                          # suite written against 2.12.1
```

`run.sh` sets `MAESTRO_CLI_NO_ANALYTICS=1`. Do the same when you call `maestro` directly.

**Authority testIDs (once per checkout, until merged).** The Authority's tab bar and its Add
Network form had no usable selectors:
- The tab label TextViews report zero bounds.
- Three inputs on the form share the accessibility label "Name".

`patches/authority-testids.patch` adds testID props only, with no behaviour change:
- `tab-elections`, `tab-tasks`, `tab-authorities`, `tab-settings`
- `add-network-name`, `add-network-authority-name`, `add-network-domain`,
  `add-network-relay-<n>`, `add-network-admin-name`, `add-network-admin-title`,
  `add-network-sign`, `add-network-create`

It also adds a `test:maestro` yarn script. The patch was not applied to the tree, because editing
Authority source while a live device session uses the Authority Metro makes attached phones reload.
Apply it when no Authority device session is running:

```sh
git apply maestro/patches/authority-testids.patch
```

`run.sh` refuses to run Authority flows until the patch is applied. The Voter's tab testIDs
(`tab-vote`, `tab-timeline`, `tab-registration`, `tab-scan`, `tab-settings`) are already in
`apps/VoteTorrentVoter/src/navigation/index.tsx`.

## 2. Build and install the DEBUG APKs

The flows need **debug** builds. A debug APK loads its JS from Metro, and the flows rely on
`__DEV__` affordances: the Voter's dev seed, its clock-offset control and its lifecycle cycler, and
the Authority's "Seed Pending Tasks (Debug)" button. A release APK has a baked-in bundle and none of
these.

```sh
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
cd apps/VoteTorrentVoter/android     && ./gradlew assembleDebug -PreactNativeArchitectures=arm64-v8a
cd ../../VoteTorrentAuthority/android && ./gradlew assembleDebug -PreactNativeArchitectures=arm64-v8a
./gradlew --stop        # an idle Gradle daemon makes the host look busy to later checks
adb -s emulator-5554 install -r apps/VoteTorrentVoter/android/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5554 install -r apps/VoteTorrentAuthority/android/app/build/outputs/apk/debug/app-debug.apk
```

- Rebuild after any native change, for example `packages/attestation-native` or a native
  dependency bump. JS-only changes need only Metro.
- `run.sh` refuses an APK that is not debuggable.
- Building only `arm64-v8a` is about 4x faster.

## 3. Start Metro (one at a time, on :8081)

Both debug apps fetch their bundle from `10.0.2.2:8081`, which bypasses `adb reverse`.
Whichever Metro owns host port 8081 decides which app's code a device runs. Run the Metro of the
app under test:

```sh
cd apps/VoteTorrentVoter && yarn start        # or apps/VoteTorrentAuthority
lsof -a -p "$(lsof -tiTCP:8081 -sTCP:LISTEN)" -d cwd -Fn | tail -1   # must print that app's dir
```

How `run.sh` handles Metro:
- It checks that the Metro on :8081 belongs to the app of each flow and refuses otherwise.
- With `--start-metro` it starts the right Metro if :8081 is free. It swaps between Voter and
  Authority as the flow order requires, and stops at exit only the Metro it started.
- It never stops a Metro it did not start: that one belongs to someone else's session.

Do not stop Metro while a device still needs the app. A debug app without Metro shows
"Unable to load script".

## 4. Boot ONE emulator

Use an existing AVD (`Pixel_8`, `Pixel_8_b`, `Pixel_8_p63`, `Pixel_rootable`). Do not create
new AVDs, and run only one emulator; three AVDs overload this host.

```sh
adb devices                          # nothing else using emulators? physical phones attached? (leave them alone)
pgrep -fl '[e]mulator|[q]emu-system|[G]radleDaemon'   # another session at work? wait or ask
emulator -avd Pixel_8_p63 -port 5554 -no-snapshot-save -no-boot-anim &
adb -s emulator-5554 wait-for-device
```

The AVDs boot from their `default_boot` snapshot with `-no-snapshot-save`. Everything done during
a boot is gone at the next boot: installed APKs, the Play Store disable, a newly enrolled
fingerprint. Re-install the APKs after each boot.

**Biometrics.** Registration, voting, signing and key release all need an enrolled fingerprint and
a screen lock. `Pixel_8_p63` had both on 2026-11-03: `dumpsys fingerprint` showed `"count":1`. If
yours has none:

```sh
adb -s emulator-5554 shell locksettings set-pin 1111
adb -s emulator-5554 shell am start -a android.settings.FINGERPRINT_ENROLL
# type the PIN, accept, then repeat until "Fingerprint added":
adb -s emulator-5554 emu finger touch 1
```

Maestro cannot touch the emulator's sensor. `run.sh` therefore runs
`scripts/biometric-autotouch.sh`, which watches for a focused BiometricPrompt and sends
`adb emu finger touch 1`. Emulator biometrics are not a proxy for hardware:
- The cancel error codes differ.
- There is no StrongBox.
- Keys are software-backed.

So a flow that passes here proves the UI path, not the Keystore or attestation path.

## 5. Run

```sh
maestro/scripts/run.sh --list                                # what would run, with tags
maestro/scripts/run.sh --device emulator-5554                # all single-device journeys, both apps
maestro/scripts/run.sh --device emulator-5554 --app voter    # one app (also: yarn workspace votetorrent-voter test:maestro)
maestro/scripts/run.sh --device emulator-5554 --tag smoke    # by tag (repeat --tag for OR)
maestro/scripts/run.sh --device emulator-5554 --flow voter/timeline.yaml          # one flow
maestro/scripts/run.sh --device emulator-5554 --app authority --start-metro \
    --env RELAY_MULTIADDR=/dns4/<your-relay>/tcp/443/wss       # parameters
```

`run.sh` does the following, in order:
1. Checks the host load. It warns, and never kills anything.
2. Preps the device: AC power, charging, Doze off, stay-awake, wake, Play Store disabled, lock and
   fingerprint state.
3. Checks that the APK is debuggable and that Metro belongs to the right app.
4. Starts the fingerprint helper.
5. Runs each selected flow as its own `maestro test` call, in a fixed order.

The fixed order puts read-only journeys first and keeps each app's flows together. Results go to
`maestro/.out/<UTC stamp>/`, which is gitignored:
- `summary.txt`: one PASS/FAIL line per flow
- `<flow>.log` and `<flow>.xml` (JUnit)
- a per-flow folder with Maestro's screenshots and commands
- `biometric-<serial>.log`

The exit code is 0 only if every flow passed.

Direct Maestro use also works. You then lose the device prep, the Metro check and the fingerprint
helper:

```sh
MAESTRO_CLI_NO_ANALYTICS=1 maestro test --device emulator-5554 maestro/voter/timeline.yaml
MAESTRO_CLI_NO_ANALYTICS=1 maestro test --device emulator-5554 --include-tags smoke maestro/   # uses config.yaml
```

### Tags

| tag | meaning |
|---|---|
| `voter`, `authority` | which app; `run.sh --app` filters on it |
| `smoke` | fast, read-only or self-cleaning; no biometric prompt |
| `launch`, `settings`, `timeline`, `join`, `registration`, `vote`, `keyholder`, `invite`, `network`, `signing`, `tasks` | journey area |
| `biometric` | raises a BiometricPrompt (the fingerprint helper or a human must answer it) |
| `dev` | uses a `__DEV__`-only affordance |
| `multi-device` | needs a network peer; excluded unless asked for (see section 7) |

### Parameters (`--env KEY=VALUE`; each flow's header lists its own defaults)

| key | default | used by |
|---|---|---|
| `VOTER_APP_ID` / `AUTHORITY_APP_ID` | `org.votetorrent.voter` / `org.votetorrent.authority` | every flow |
| `BOOT_TIMEOUT_MS` | `300000` | launch subflows (the Voter's dev-seed boot is slow) |
| `SEEDED_ELECTION_TITLE` | `Dev Voter Registration Election` | Voter launch, timeline |
| `REG_FIRST_NAME` `REG_LAST_NAME` `REG_DOB_DIGITS` `REG_EMAIL` `REG_PHONE` `REG_ADDRESS_1` `REG_PARTY` | `Ana` `Lee` `01152000` `ana.lee@example.com` `5550101234` `12 Main St` `independent` | registration flows |
| `CONFIRM_TIMEOUT_MS` | `180000` | registration-request |
| `VOTE_PICK_1..3` | `diana` `priya` `angela` | ballot answering (candidate option codes) |
| `SUBMIT_TIMEOUT_MS` / `SEND_TIMEOUT_MS` | `120000` / `900000` | vote submit / send |
| `NETWORK_NAME` `AUTHORITY_NAME` `ADMIN_NAME` `ADMIN_TITLE` | `Maestro Net` `Maestro Office` `Sam Lee` `Clerk` | Authority create-network |
| `RELAY_MULTIADDR` | `/dns4/relay.example.invalid/tcp/443/wss` (a placeholder that only satisfies the form) | create-network; pass your real relay for any cross-device use |
| `CREATE_TIMEOUT_MS` `INVITE_TIMEOUT_MS` | `180000` `120000` | create-network, mint-voter-join-code |
| `JOIN_VIA` `JOIN_CODE` `EXPECTED_NETWORK_NAME` `JOIN_TIMEOUT_MS` | `type`, (empty), `.+`, `300000` | join flows |
| `DECISION_TIMEOUT_MS` `REQUEST_WAIT_MS` `RELEASE_WAIT_MS` | `900000` `600000` `600000` | multi-device waits |
| `ELECTION_TITLE` `KEYHOLDER_NAME` | `Maestro Election` `kh-a` | keyholder screen |

Rules for parameter values:
- Keep typed values free of a double `r`. On a debug build, two R key events in quick succession
  with no text field focused reload the JS bundle (RN's double-tap-R). It shows up as the app
  "navigating to Home" mid-typing.
- Never put secrets, real relay addresses or anything from `apps/*/bootstrap.config.json` into a
  flow or a default. Pass them with `--env` at run time.

How defaults work: every flow declares its parameters in its `env:` header as
`"${typeof X == 'undefined' ? '<default>' : X}"`. A value passed with `-e`/`--env` therefore wins
whichever order Maestro applies the two in.

## 6. Journeys and validation status

| flow | tags | covers | status |
|---|---|---|---|
| voter/launch-home | voter smoke launch | fresh install, dev-seed boot, Home, tab bar | unvalidated |
| voter/tabs | voter smoke | every tab's landmark | unvalidated |
| voter/settings-language | voter smoke settings | English to Spanish and back | unvalidated |
| voter/home-lifecycle-cycler | voter smoke dev | Home card in every lifecycle state, Validation Details | unvalidated |
| voter/join-network-invalid-code | voter smoke join | join screen, bad-code error | unvalidated |
| voter/timeline | voter smoke timeline | rail, registration panel, dev clock into voting | unvalidated |
| voter/ballot-preview | voter smoke vote | preview ballot before voting opens | unvalidated |
| voter/keyholders-and-results | voter timeline keyholder | Keyholders and Results screens | unvalidated |
| voter/registration-form-validation | voter smoke registration | register form field errors | unvalidated |
| voter/registration-request | voter registration biometric | three-step form, submit, biometric confirm | unvalidated |
| voter/vote-cast-and-receipt | voter vote biometric | vote, review, submit, receipt, saved-vote line | unvalidated |
| authority/launch-no-network | authority smoke launch | fresh install, empty state | unvalidated (needs patch) |
| authority/tabs | authority smoke | every tab | unvalidated (needs patch) |
| authority/join-network-invalid-code | authority smoke join | join screen, bad-code error | unvalidated (needs patch) |
| authority/accept-invitation-entry | authority smoke invite | accept-invitation paste screen | unvalidated (needs patch) |
| authority/signing-key-setup | authority signing biometric | secure-signing provisioning (the signing ceremony's provision leg) | unvalidated (needs patch) |
| authority/create-network | authority network biometric | Add Network, first-run signing detours, network listed | unvalidated (needs patch) |
| authority/mint-voter-join-code | authority invite biometric | voter join code, QR, fingerprint, copy | unvalidated (needs patch) |
| authority/tasks-seeded-signature | authority tasks signing biometric dev | seeded signature task signed | unvalidated (needs patch; the seed may need an election) |
| multi-device/voter-join-network | voter multi-device join | join with a code (paste or typed) | unvalidated: needs an Authority network |
| multi-device/voter-register-and-await-decision | voter multi-device registration biometric | register, wait for approval | unvalidated: needs an officer |
| multi-device/voter-submit-registration | voter multi-device registration biometric | register, submit only | unvalidated: needs a joined election |
| multi-device/voter-check-registered | voter multi-device registration | registered card after approval | unvalidated: needs an officer |
| multi-device/voter-vote-when-open | voter multi-device vote biometric | vote at real votingStarts, send to pool | unvalidated: needs a live election and 3+ voters |
| multi-device/authority-join-network | authority multi-device join biometric | officer joins with a code | unvalidated: needs a network |
| multi-device/authority-registration-decision | authority multi-device registration biometric | approve a voter's request | unvalidated: needs a request |
| multi-device/authority-keyholder-screen | authority multi-device keyholder | Keyholder screen, DKG status | unvalidated: needs an election with keyholders |
| multi-device/authority-key-release | authority multi-device keyholder biometric | release a key share | unvalidated: needs a Releasing Keys election |

When a flow passes on a device, change its status to `validated (<date>, <AVD>, <maestro version>)`.

## 7. Cross-device journeys

`scripts/run-multi-device.sh` sequences the per-device steps. All steps run one after another,
because both debug apps share the one Metro on :8081.

- **`same-device-join --device emulator-5554`.** One emulator, both apps:
  1. The Authority founds a network and mints a voter join code. COPY puts it on the emulator
     clipboard.
  2. The Voter taps Paste and joins.

  Needs a relay both app nodes can reach: `--env RELAY_MULTIADDR=...`.
- **`host-seeded-voter --device <s> --join-code-file <f>`.** Run `scripts/seed-election.sh voters`
  first. It holds a host officer that auto-approves, keyholders and two host voters. The Voter then
  joins with that code, registers, waits for approval, votes when voting opens and sends to the pool.
- **`officer-approves --authority-device <a> --voter-device <v> --join-code-file <f>`.** The Voter
  joins and submits, the officer approves on the Authority device, and the Voter relaunches showing
  registered.

The join code is read from a file into the flow environment and never echoed. Keep that file out of
the repo.

## 8. Known emulator limits and traps

Each of these has cost a device run in this project:
- **Doze ("Unable to load script").**
  - Cause: AVDs report a battery, so `svc power stayon` alone is ignored. The app uid gets
    `blocked=DOZE`.
  - Fix: `run.sh` sends `emu power ac on`, sets charging and runs `deviceidle disable` before every
    run.
- **Play Store kills the app mid-run.** A WebView auto-update force-stops every app that uses it.
  `run.sh` disables `com.android.vending`. The disable does not survive a reboot.
- **Locked screen after boot.** On a PIN AVD, credential storage stays locked until the first unlock
  (`RUNNING_LOCKED`), and `am start` then reports "Activity class does not exist". Unlock first;
  `run.sh` warns.
- **A busy host starves the Voter's boot.** The dev-seed boot blocks the JS thread for minutes.
  - Symptoms: thousands of skipped frames, then SystemUI ANRs.
  - Never run `nx run-many`, `yarn workspaces foreach ... test` or another Gradle build while the
    emulator runs.
  - Gate on the 5-minute load average, not the 1-minute one.
- **The wrong Metro.** A Metro from the other app or another checkout serves its own bundle. The
  symptom is a missing-native-module red box for a module this app does not use, for example
  `RNCClipboard` on the Voter. Check the cwd of the :8081 listener.
- **LogBox covers the tab bar.** A debug toast sits over the bottom 70 dp, and the Authority logs one
  `console.error` on every cold start. `subflows/common/dismiss-logbox.yaml` dismisses a
  single-log ("!") toast. A badge with a number (2+ logs) has no selectable id: open it by hand.
- **Served-file edits reload attached devices.** Editing app source or `node_modules` that a running
  Metro serves triggers Fast Refresh or a full reload on every attached debug app. Do not edit
  during someone else's device session.
- **Debug Voter always has a network.** The dev seed founds "VoteTorrent Dev Network" on first boot.
  Joining another network may hit the app's one-network rule
  ("already belongs to another election authority's network").
- **RN TextInputs report `text=""` to uiautomator.** Assert on placeholders, error ids or the next
  screen, not on an input's text.
- **Emulator clocks drift** (about 45 s behind the host was seen). Real-clock waits use generous
  timeouts.

## 9. For agents

Before a run:
- Read sections 3, 4 and 8.
- Check `adb devices`, `pgrep -fl '[e]mulator|[q]emu-system|[G]radleDaemon'` and the cwd of the
  :8081 listener.
- If another session is using the emulator, Metro or Gradle, stop and report. Never kill a process
  you did not start.
- Never touch a physical phone. `run.sh` refuses one unless you pass `--allow-physical`, which is for
  a human with that phone in hand.

During the run:
- Use exactly one AVD, booted by you. Shut it down at the end, along with any Metro you started.
- Report results from `summary.txt` and quote the failing step from `<flow>.log`. Only a `PASS` line
  counts as validated. Do not infer a pass from a screenshot.

Writing or fixing flows:
- Select by testID (`id:`; Android resource-id). Regex is allowed: `id: "confirmation-(waiting|pending)"`.
- Then by a stable accessibility label. Use visible English only as a last resort.
- If a journey cannot be selected without one, add a `testID` prop only, with no behaviour change,
  and list it in your report.
- Keep flows parameterised through `env`. Never hardcode host paths, relays or codes.
- Run `maestro check-syntax <file>` on every changed flow.
