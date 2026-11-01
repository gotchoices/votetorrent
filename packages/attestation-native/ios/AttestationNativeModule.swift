//
//  AttestationNativeModule.swift — iOS counterpart of the Android `AttestationNative` TurboModule.
//
//  STATUS: TYPECHECKS against the iOS 26.2 SDK (arm64-apple-ios15.1, exit 0). RUNTIME behaviour is
//  still UNPROVEN — App Attest returns `isSupported == false` on the Simulator, so every
//  Secure Enclave / App Attest / biometric claim below needs a physical iPhone. A clean typecheck
//  is not working attestation. See ../README.md for the remaining proof legs.
//
//  The one exception: the DER -> compact low-S signature conversion (SignatureEncoding.swift) is
//  pure byte manipulation and IS fully proven on the host — 17/17 against @noble/curves v2 vectors.
//
//  Mirrors the 5-method surface of
//  `packages/attestation-native/src/specs/NativeAttestation.ts` so the JS orchestration layer
//  (`real-attestation-producer.ts`) can stay platform-agnostic apart from the payload shape.
//
//  THE STRUCTURAL DIFFERENCE FROM ANDROID (spike 080): Android's Keystore key both carries the
//  attestation cert chain AND signs votes. Apple's App Attest key can ONLY be used via
//  `generateAssertion` — it cannot sign arbitrary payloads. So this module manages TWO keys:
//
//    K_att  — the App Attest key. Attests once, then only ever produces assertions.
//    K_vote — a separate Secure Enclave P-256 key. Signs ballots. Has NO attestation of its own.
//
//  K_vote is bound to the attested identity by an ASSERTION over a clientDataHash that commits to
//  K_vote's public bytes. That cross-sign is the entire security argument; without it K_vote is an
//  unattested key and the attestation proves nothing about the thing doing the voting.
//

import Foundation
// RCTPromiseResolveBlock / RCTPromiseRejectBlock live here.
//
// PLAIN import, deliberately. This was `#if canImport(React) / import React / #endif` until
// 2026-08-26, to let the standalone `typecheck:ios` gate run without RN headers. That guard was
// load-bearing for the gate's blind spot rather than for any real build: React is always present
// when this file is compiled inside an app, so the conditional could only ever mask its absence.
// The gate now compiles a stand-in MODULE named React and proves, on every run, that stripping
// this line makes it fail — so the guard is no longer needed and its removal is what gives that
// proof teeth. See scripts/typecheck-ios.sh, and `typecheck:ios:app` for the authoritative build.
import React
import DeviceCheck
import CryptoKit
import LocalAuthentication
import Security
import UIKit

@objc(AttestationNative)
class AttestationNativeModule: NSObject {

  // Distinct from the Android aliases by design (D-07: different apps, different threat surfaces).
  private static let voteKeyTag = "org.votetorrent.voter.VOTE_KEY_V1"
  // The two device-key aliases in use today (Voter real-attestation-producer.ts, Authority
  // device-signer.ts). They keep the original tag so no installed Keychain key is orphaned (62-127).
  private static let legacyDeviceKeyAliases: Set<String> = [
    "VOTETORRENT_DEVICE_KEY_V1",
    "VOTETORRENT_AUTHORITY_SIGNING_KEY_V1"
  ]
  private static let deviceKeyAliasPattern = try! NSRegularExpression(pattern: "^[A-Z0-9_]{1,64}$")

  /// The single alias -> Keychain tag mapping for the device-key methods. A legacy alias maps to
  /// `voteKeyTag`; any other valid alias gets its own tag; an invalid alias yields nil (the caller
  /// rejects INVALID_ARGUMENT before touching the Keychain).
  private static func deviceKeyTag(for alias: String) -> String? {
    if legacyDeviceKeyAliases.contains(alias) { return Self.voteKeyTag }
    let range = NSRange(alias.startIndex..<alias.endIndex, in: alias)
    guard deviceKeyAliasPattern.firstMatch(in: alias, range: range) != nil else { return nil }
    return "org.votetorrent.devicekey." + alias
  }

  private static let recoveryKeyTag = "org.votetorrent.voter.RECOVERY_KEY_V1"
  private static let appAttestKeyIdDefaultsKey = "org.votetorrent.voter.APPATTEST_KEY_ID"

  @objc static func requiresMainQueueSetup() -> Bool { return false }

  // MARK: - Secure Enclave key helpers

  /// Creates a Secure Enclave P-256 key.
  ///
  /// `.biometryCurrentSet` is the iOS analogue of Android's
  /// `setInvalidatedByBiometricEnrollment(true)`: the key is destroyed if the enrolled biometric set
  /// changes. `.devicePasscode` is the analogue of `DEVICE_CREDENTIAL` and is NOT governed by
  /// biometric enrolment — which is exactly why the recovery key uses it (D-16).
  private func createSecureEnclaveKey(tag: String, requireBiometry: Bool) throws -> SecKey {
    var accessError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
      kCFAllocatorDefault,
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      requireBiometry ? [.privateKeyUsage, .biometryCurrentSet] : [.privateKeyUsage, .devicePasscode],
      &accessError
    ) else {
      throw accessError!.takeRetainedValue() as Error
    }

    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      // The Secure Enclave supports P-256 and nothing else — which happens to match the project's
      // existing P-256/prehash/lowS signing contract exactly. No negotiation needed.
      kSecAttrKeySizeInBits as String: 256,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: tag.data(using: .utf8)!,
        kSecAttrAccessControl as String: access
      ]
    ]

    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      throw error!.takeRetainedValue() as Error
    }
    return key
  }

  private func loadKey(tag: String, context: LAContext? = nil) -> SecKey? {
    var query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag.data(using: .utf8)!,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: true
    ]
    if let context = context {
      query[kSecUseAuthenticationContext as String] = context
    }
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
    return (item as! SecKey)
  }

  // MARK: - Invalidated-key recovery (measured 2026-08-25)

  /// What a stored key can still DO, as opposed to whether it is merely present.
  ///
  /// These are not the same question, and conflating them wedged this app permanently. A Secure
  /// Enclave key destroyed by a biometric re-enrolment (`.biometryCurrentSet`) still satisfies
  /// `SecItemCopyMatching` and still yields a public key from `SecKeyCopyPublicKey` — it fails only
  /// at the moment of signing. So `loadKey(tag:) ?? create...` kept handing back a DEAD key forever:
  /// every ceremony would attest a key the device can never sign with, with no path back. Measured
  /// on an iPhone 13, 2026-08-25 — the vote key survived a Face ID change, `provisionDeviceKey`
  /// happily returned its public bytes, App Attest attested it, and only the §4 possession signature
  /// failed (CryptoTokenKit -3). Android never reaches this state because its path deletes and
  /// regenerates on every call.
  private enum KeyLiveness {
    case usable
    case invalidated
    /// Could not tell. Treated as usable — see `provisionDeviceKey`. NEVER delete on this.
    case indeterminate
  }

  /// Probe a key's liveness WITHOUT raising a biometric prompt.
  ///
  /// `provisionDeviceKey` is documented as key-creation-only and must never prompt, so this attaches
  /// an `LAContext` with `interactionNotAllowed` and attempts a signature over a throwaway digest.
  /// The point is the ERROR, not the signature:
  ///
  ///   * a LIVE biometry-gated key refuses for want of UI  -> `errSecInteractionNotAllowed` /
  ///     `LAError.notInteractive`, i.e. the key is fine, it just needs a prompt we deliberately
  ///     withheld;
  ///   * a DESTROYED key refuses because it no longer exists -> CryptoTokenKit -3 /
  ///     `errSecItemNotFound`.
  ///
  /// Anything else is `.indeterminate`. That asymmetry is deliberate and load-bearing: a false
  /// positive here DELETES a voter's device identity and forces a re-association, so this reports
  /// `.invalidated` only on a positive, specific signal and never on a generic failure.
  private func probeKeyLiveness(tag: String) -> (liveness: KeyLiveness, detail: String) {
    let context = LAContext()
    context.interactionNotAllowed = true

    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag.data(using: .utf8)!,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: true,
      kSecUseAuthenticationContext as String: context
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return (.invalidated, "load:errSecItemNotFound") }
    guard status == errSecSuccess, let key = item else { return (.indeterminate, "load:OSStatus \(status)") }

    var error: Unmanaged<CFError>?
    // Content is irrelevant — only whether the Enclave will engage with the key at all.
    let scratch = Data(repeating: 0, count: 32)
    if SecKeyCreateSignature(key as! SecKey, .ecdsaSignatureDigestX962SHA256,
                             scratch as CFData, &error) != nil {
      // A key that signs with no interaction at all is alive (and simply not biometry-gated).
      return (.usable, "signed-without-interaction")
    }
    let err = error!.takeRetainedValue() as Error as NSError
    let detail = "\(err.domain):\(err.code)"

    // DOMAIN FIRST — the code spaces overlap (see signWith's identical warning).
    if err.domain == "CryptoTokenKit" && err.code == -3 { return (.invalidated, detail) }
    if err.domain == NSOSStatusErrorDomain && err.code == Int(errSecItemNotFound) { return (.invalidated, detail) }
    // The key is alive and correctly demanding the prompt we withheld.
    if err.code == Int(errSecInteractionNotAllowed) || err.code == LAError.notInteractive.rawValue {
      return (.usable, detail)
    }
    return (.indeterminate, detail)
  }

  private func deleteKey(tag: String) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag.data(using: .utf8)!,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom
    ]
    SecItemDelete(query as CFDictionary)
  }

  /// 33-byte compressed SEC1 point, hex — the `publicKeyCompressedHex` contract (D-04/D-08).
  /// `SecKeyCopyExternalRepresentation` yields UNCOMPRESSED X9.62 (0x04‖X‖Y); compression is ours
  /// to do. Getting this wrong registers a `UserKey.PubKey` that can never verify, and `verify()`
  /// swallows exceptions and returns false — so it fails closed AND silently.
  private func compressedHex(from publicKey: SecKey) throws -> String {
    var error: Unmanaged<CFError>?
    guard let data = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
      throw error!.takeRetainedValue() as Error
    }
    guard data.count == 65, data[0] == 0x04 else {
      throw NSError(domain: "AttestationNative", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "unexpected public key encoding (\(data.count) bytes)"])
    }
    let x = data.subdata(in: 1..<33)
    let y = data.subdata(in: 33..<65)
    let prefix: UInt8 = (y[y.count - 1] % 2 == 0) ? 0x02 : 0x03
    return ([prefix] + x).map { String(format: "%02x", $0) }.joined()
  }

  // DER -> compact low-S conversion lives in SignatureEncoding.swift as free functions so it can be
  // unit-tested on the host without an iPhone (it is pure byte manipulation). It is PROVEN there
  // against @noble/curves v2 vectors — 12 signatures incl. 6 high-S, plus 5 malformed inputs.
  //
  // THE TRAP it exists to close: Android's signWithDeviceKey returns compact low-S already; iOS
  // SecKeyCreateSignature returns DER and does NOT normalize S. Forwarding it unchanged fails
  // @noble/curves v2's default lowS:true as an ordinary "invalid signature", never a crash.

  // MARK: - (1) provisionDeviceKey

  /// Generates the App Attest key AND the separate Secure Enclave vote key.
  /// Resolves `{ publicKeyCompressedHex, appAttestKeyId, keyAlias }`.
  @objc(provisionDeviceKey:resolver:rejecter:)
  func provisionDeviceKey(_ keyAlias: String,
                          resolver resolve: @escaping RCTPromiseResolveBlock,
                          rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let deviceTag = Self.deviceKeyTag(for: keyAlias) else {
      reject("INVALID_ARGUMENT", "invalid device key alias", nil)
      return
    }
    let service = DCAppAttestService.shared
    // Simulator and unsupported hardware land here. This is the ONLY honest place to fail — do not
    // fall back to a software key: an unattestable device must not silently become attestable.
    guard service.isSupported else {
      reject("ATTESTATION_UNSUPPORTED", "App Attest is not supported on this device", nil)
      return
    }

    service.generateKey { keyId, error in
      if let error = error {
        reject("APPATTEST_GENERATE_KEY_FAILED", error.localizedDescription, error)
        return
      }
      guard let keyId = keyId else {
        reject("APPATTEST_GENERATE_KEY_FAILED", "generateKey returned no keyId", nil)
        return
      }
      do {
        UserDefaults.standard.set(keyId, forKey: Self.appAttestKeyIdDefaultsKey)

        // Recover from a destroyed vote key instead of handing it back forever. Only a POSITIVE
        // invalidation signal deletes; `.indeterminate` keeps the existing key, because wrongly
        // deleting a live one destroys the voter's device identity.
        var existing = self.loadKey(tag: deviceTag)
        var reprovisioned = false
        var probeDetail = "no-existing-key"
        if existing != nil {
          let probe = self.probeKeyLiveness(tag: deviceTag)
          probeDetail = probe.detail
          if probe.liveness == .invalidated {
            self.deleteKey(tag: deviceTag)
            existing = nil
            reprovisioned = true
          }
        }
        let voteKey = try existing
          ?? self.createSecureEnclaveKey(tag: deviceTag, requireBiometry: true)
        guard let pub = SecKeyCopyPublicKey(voteKey) else {
          reject("KEY_ERROR", "could not derive the vote key's public key", nil); return
        }
        resolve([
          "publicKeyCompressedHex": try self.compressedHex(from: pub),
          "appAttestKeyId": keyId,
          "keyAlias": keyAlias,
          // TRUE means K_vote CHANGED: any challenge already issued against the previous key is
          // void, and an existing Association no longer describes this device.
          "reprovisioned": reprovisioned,
          // The raw probe verdict, carried so a failure can be diagnosed from captured output
          // rather than re-derived from a guess about what the Enclave returns.
          "voteKeyProbe": probeDetail
        ])
      } catch {
        reject("KEY_ERROR", error.localizedDescription, error)
      }
    }
  }

  // MARK: - (1b) getCurrentDeviceKey

  /// READ-ONLY lookup of the existing Secure Enclave vote key (63-18 fix). Never generates, deletes,
  /// prompts or mutates the Keychain. Resolves `{ publicKeyCompressedHex, keyAlias }` — the same
  /// key `provisionDeviceKey` would reuse. Rejects `DEVICE_KEY_ABSENT` (no key) or
  /// `DEVICE_KEY_INVALIDATED` (POSITIVE invalidation signal only; `.indeterminate` is treated usable).
  @objc(getCurrentDeviceKey:resolver:rejecter:)
  func getCurrentDeviceKey(_ keyAlias: String,
                           resolver resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let deviceTag = Self.deviceKeyTag(for: keyAlias) else {
      reject("INVALID_ARGUMENT", "invalid device key alias", nil)
      return
    }
    guard let voteKey = self.loadKey(tag: deviceTag) else {
      reject("DEVICE_KEY_ABSENT", "no device key exists (read-only lookup — nothing was generated)", nil)
      return
    }
    let probe = self.probeKeyLiveness(tag: deviceTag)
    if probe.liveness == .invalidated {
      reject("DEVICE_KEY_INVALIDATED", "device key is permanently invalidated (\(probe.detail))", nil)
      return
    }
    guard let pub = SecKeyCopyPublicKey(voteKey) else {
      reject("DEVICE_KEY_READ_FAILED", "could not derive the vote key's public key", nil); return
    }
    do {
      resolve([
        "publicKeyCompressedHex": try self.compressedHex(from: pub),
        "keyAlias": keyAlias
      ])
    } catch {
      reject("DEVICE_KEY_READ_FAILED", error.localizedDescription, error)
    }
  }

  // MARK: - (2) produceAttestation

  /// Answers an issued challenge. Implements ATTESTATION-CONTRACT-IOS.md §2 and §3.
  ///
  /// - `boundDigest` — the base64url `Digest(nonce, deviceKey)` STRING (§1).
  /// - `assertionDigest` — the base64url `ASSERTION_DIGEST` STRING (§3.1), i.e.
  ///   `digestFields(['votetorrent/ios-assertion/v1', BOUND_DIGEST, voteKeyCompressedHex])`.
  ///
  /// **Both are computed in JS and passed down finished.** This method must NEVER construct either
  /// value natively. `digestFields`' encoding is length-prefixed and type-tagged, and re-deriving it
  /// in a second language is exactly the "independent reimplementation" SIGN-05 forbids — the
  /// earlier draft of this file built the assertion clientData as `boundDigest + "|" + voteKeyHex`,
  /// a non-injective concatenation the contract explicitly rejects.
  ///
  /// Both are hashed the SAME way to reach a `clientDataHash`: `SHA256(UTF-8 bytes of the string)`.
  /// One rule covers both, so there is one place to get it wrong instead of two. This is a THIRD
  /// encoding of BOUND_DIGEST alongside Android's two (spike 080 P5).
  ///
  /// **Caller obligation (§3.4):** the returned `publicKeyCompressedHex` MUST be compared against
  /// the vote key the caller used to build `assertionDigest`. This method reads whatever key is
  /// currently under the vote alias; if it ever differs from the one JS hashed, the assertion binds
  /// the wrong key and the authority's `verifyCrossSign` rejects with "K_vote is not bound to this
  /// attestation" — a legible failure, but one the caller should catch first.
  ///
  /// **`attestKey` may be called only ONCE per App Attest key.** Unlike Android's
  /// delete-and-regenerate, a re-attestation needs a NEW `generateKey`. This yields the same
  /// key-non-reuse property D-13 was rewritten around, for free.
  ///
  /// Proof of possession of K_vote (§4) is a SEPARATE `signWithDeviceKey` call made by JS after
  /// this one — it is not produced here, because it requires the biometric prompt this method's
  /// App Attest path does not use.
  @objc(produceAttestation:boundDigest:assertionDigest:enableDeviceCheck:resolver:rejecter:)
  func produceAttestation(_ keyAlias: String,
                          boundDigest: String,
                          assertionDigest: String,
                          enableDeviceCheck: Bool,
                          resolver resolve: @escaping RCTPromiseResolveBlock,
                          rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let deviceTag = Self.deviceKeyTag(for: keyAlias) else {
      reject("INVALID_ARGUMENT", "invalid device key alias", nil)
      return
    }
    let service = DCAppAttestService.shared
    guard service.isSupported else {
      reject("ATTESTATION_UNSUPPORTED", "App Attest is not supported on this device", nil); return
    }
    guard let keyId = UserDefaults.standard.string(forKey: Self.appAttestKeyIdDefaultsKey) else {
      reject("NO_KEY_PROVISIONED", "provisionDeviceKey has not run", nil); return
    }
    guard let voteKey = self.loadKey(tag: deviceTag), let votePub = SecKeyCopyPublicKey(voteKey) else {
      reject("NO_KEY_PROVISIONED", "no vote key present", nil); return
    }

    let clientDataHash = Data(SHA256.hash(data: Data(boundDigest.utf8)))

    service.attestKey(keyId, clientDataHash: clientDataHash) { attestation, error in
      if let error = error {
        reject("APPATTEST_ATTEST_FAILED", error.localizedDescription, error); return
      }
      guard let attestation = attestation else {
        reject("APPATTEST_ATTEST_FAILED", "attestKey returned no attestation object", nil); return
      }
      do {
        // THE CROSS-SIGN (§3). The assertion is what lets the attested app vouch for K_vote.
        // `assertionDigest` arrives finished from JS — hashed here exactly as `boundDigest` was.
        let voteKeyHex = try self.compressedHex(from: votePub)
        let assertionClientDataHash = Data(SHA256.hash(data: Data(assertionDigest.utf8)))
        service.generateAssertion(keyId, clientDataHash: assertionClientDataHash) { assertion, assertError in
          if let assertError = assertError {
            reject("APPATTEST_ASSERT_FAILED", assertError.localizedDescription, assertError); return
          }
          // An empty assertion would silently produce an unbindable ceremony — fail loudly instead.
          guard let assertion = assertion else {
            reject("APPATTEST_ASSERT_FAILED", "generateAssertion returned no assertion", nil); return
          }
          resolve([
            "attestationObjectBase64": attestation.base64EncodedString(),
            "assertionBase64": assertion.base64EncodedString(),
            "appAttestKeyId": keyId,
            // §3.4: the caller MUST check this equals the vote key it hashed into assertionDigest.
            "publicKeyCompressedHex": voteKeyHex,
            "attestationTimeMillis": Int(Date().timeIntervalSince1970 * 1000),
            // D-12 analogue: the DeviceCheck leg is independently gated, exactly as
            // `enablePlayIntegrity` gates Play Integrity on Android. Unused under bar A (spike 082).
            "deviceCheckToken": ""
          ])
        }
      } catch {
        reject("KEY_ERROR", error.localizedDescription, error)
      }
    }
  }

  // MARK: - (2b) Android-only R1d methods (spike 104)

  /// Android binds an attestation challenge only at key generation, so its voting key is provisioned
  /// with a fixed tag and the nonce is answered by a throwaway key. iOS has no such constraint (App
  /// Attest attests a separate key and cross-signs the vote key), and the iOS producer never calls
  /// these two. They exist so the four ABI layers agree.
  @objc(provisionAttestedDeviceKey:attestationChallengeBase64:resolver:rejecter:)
  func provisionAttestedDeviceKey(_ keyAlias: String,
                                  attestationChallengeBase64: String,
                                  resolver resolve: @escaping RCTPromiseResolveBlock,
                                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    reject("UNSUPPORTED_PLATFORM", "provisionAttestedDeviceKey is Android-only; iOS uses provisionDeviceKey", nil)
  }

  @objc(produceFreshAttestation:boundDigest:boundDigestUtf8Base64:enablePlayIntegrity:resolver:rejecter:)
  func produceFreshAttestation(_ keyAlias: String,
                               boundDigest: String,
                               boundDigestUtf8Base64: String,
                               enablePlayIntegrity: Bool,
                               resolver resolve: @escaping RCTPromiseResolveBlock,
                               rejecter reject: @escaping RCTPromiseRejectBlock) {
    reject("UNSUPPORTED_PLATFORM", "produceFreshAttestation is Android-only; iOS uses produceAttestation", nil)
  }

  // MARK: - (3) signWithDeviceKey

  /// Biometric-gated P-256 signature over `digestBase64`.
  /// `digestBase64` is PLAIN base64 of the RAW digest bytes — never base64url, never UTF-8-of-a-
  /// string. The base64 ENCODING is identical to Android's `signWithDeviceKey`; the signing DOMAIN
  /// is not: iOS signs the input as the FINAL hash, so callers pre-hash via `nativeSignInputBytes`
  /// (packages/attestation-native/src/native-sign-input.ts).
  @objc(signWithDeviceKey:digestBase64:promptTitle:promptSubtitle:promptNegativeButton:resolver:rejecter:)
  func signWithDeviceKey(_ keyAlias: String,
                         digestBase64: String,
                         promptTitle: String,
                         promptSubtitle: String,
                         promptNegativeButton: String,
                         resolver resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let deviceTag = Self.deviceKeyTag(for: keyAlias) else {
      reject("INVALID_ARGUMENT", "invalid device key alias", nil)
      return
    }
    signWith(tag: deviceTag, digestBase64: digestBase64, reason: promptSubtitle,
             resolve: resolve, reject: reject)
  }

  // MARK: - (4)(5) recovery key

  @objc(provisionRecoveryKey:resolver:rejecter:)
  func provisionRecoveryKey(_ keyAlias: String,
                            resolver resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    let context = LAContext()
    var authError: NSError?
    // D-18 analogue: no passcode set at all means no recovery ceremony can EVER succeed. Detect it
    // before creating anything, and report it distinctly from a ceremony that was attempted.
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &authError) else {
      reject("NO_DEVICE_CREDENTIAL", "no device passcode is configured", authError); return
    }
    do {
      let key = try loadKey(tag: Self.recoveryKeyTag)
        ?? createSecureEnclaveKey(tag: Self.recoveryKeyTag, requireBiometry: false)
      guard let pub = SecKeyCopyPublicKey(key) else {
        reject("KEY_ERROR", "could not derive the recovery key's public key", nil); return
      }
      resolve(["publicKeyCompressedHex": try compressedHex(from: pub), "keyAlias": keyAlias])
    } catch {
      reject("KEY_ERROR", error.localizedDescription, error)
    }
  }

  @objc(signWithRecoveryKey:digestBase64:promptTitle:promptSubtitle:promptNegativeButton:resolver:rejecter:)
  func signWithRecoveryKey(_ keyAlias: String,
                           digestBase64: String,
                           promptTitle: String,
                           promptSubtitle: String,
                           promptNegativeButton: String,
                           resolver resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
    signWith(tag: Self.recoveryKeyTag, digestBase64: digestBase64, reason: promptSubtitle,
             resolve: resolve, reject: reject)
  }

  // MARK: - shared signing path

  /// One pending device-key / recovery-key sign at a time (D-112). `canceled` and `settled` are
  /// read and written under `pendingSignLock`. `settled` makes the JS promise settle exactly once:
  /// either `finishPendingSign` (the system call returned) or `cancelPendingSign` (its 2 s cap ran
  /// out first) settles it, never both.
  private final class PendingSign {
    let context: LAContext
    let reject: RCTPromiseRejectBlock
    let done = DispatchGroup()
    var canceled = false
    var settled = false
    init(context: LAContext, reject: @escaping RCTPromiseRejectBlock) {
      self.context = context
      self.reject = reject
    }
  }

  private let signQueue = DispatchQueue(label: "org.votetorrent.attestation.sign",
                                        qos: .userInitiated)
  private let pendingSignLock = NSLock()
  private var pendingSign: PendingSign?

  private enum SignOutcome {
    case signature(String)
    case failure(code: String, message: String, error: Error?)
  }

  /// Signs run on `signQueue` with a fresh LAContext per call (reuse duration 0), so an open
  /// Face ID / passcode sheet never blocks the module's method queue. Only one device/recovery
  /// sign may be pending (`PROMPT_BUSY` otherwise); `cancelPendingSign` invalidates it (D-110,
  /// D-112, D-113; todo 2026-10-31-ios-native-sign-has-no-timeout-or-cancel). Unproven on device
  /// until the iPhone leg.
  private func signWith(tag: String, digestBase64: String, reason: String,
                        resolve: @escaping RCTPromiseResolveBlock,
                        reject: @escaping RCTPromiseRejectBlock) {
    guard let digest = Data(base64Encoded: digestBase64), digest.count == 32 else {
      reject("INVALID_DIGEST_ENCODING",
             "digestBase64 must be plain base64 of 32 raw digest bytes", nil)
      return
    }
    let context = LAContext()
    context.localizedReason = reason
    context.touchIDAuthenticationAllowableReuseDuration = 0
    let pending = PendingSign(context: context, reject: reject)
    pendingSignLock.lock()
    if pendingSign != nil {
      pendingSignLock.unlock()
      reject("PROMPT_BUSY", "another biometric sign is already pending", nil)
      return
    }
    pending.done.enter()
    pendingSign = pending
    pendingSignLock.unlock()

    signQueue.async { [self] in
      pendingSignLock.lock()
      let alreadyCanceled = pending.canceled
      pendingSignLock.unlock()
      if alreadyCanceled {
        finishPendingSign(pending, outcome: .failure(code: "CANCELED",
                                                     message: "signing was cancelled", error: nil),
                          resolve: resolve, reject: reject)
        return
      }
      guard let key = loadKey(tag: tag, context: pending.context) else {
        finishPendingSign(pending, outcome: .failure(code: "NO_KEY_PROVISIONED",
                                                     message: "no key under \(tag)", error: nil),
                          resolve: resolve, reject: reject)
        return
      }

      var error: Unmanaged<CFError>?
    // `.ecdsaSignatureDigestX962SHA256` treats the input as the FINAL ECDSA hash (no internal
    // hash) = noble `prehash: false`. Android's SHA256withECDSA hashes once, so the shared JS helper
    // (nativeSignInputBytes) pre-hashes on iOS to compensate. The PoP relies on this raw behaviour:
    // do NOT switch to the `...MessageX962...` variant without changing the PoP verifier, the
    // contract doc and the pinned hardware vector together.
      guard let sig = SecKeyCreateSignature(key, .ecdsaSignatureDigestX962SHA256,
                                            digest as CFData, &error) as Data? else {
        let err = error!.takeRetainedValue() as Error as NSError
          // LAError.userCancel / .userFallback / .biometryLockout map onto the Android code table.
          // DOMAIN FIRST — these code spaces OVERLAP, measured 2026-08-25 (spike 085 leg 7):
          //
          //     LAError.userFallback            = -3   (com.apple.LocalAuthentication)
          //     key invalidated by re-enrolment = -3   (CryptoTokenKit)
          //
          // Matching on the raw code alone reports an INVALIDATED KEY as CANCELED — a permanent,
          // recoverable-by-re-provisioning condition disguised as "the user tapped cancel", so the app
          // would retry forever instead of re-provisioning. An earlier revision of this fix had exactly
          // that bug: it checked CryptoTokenKit only in `default`, which `-3` never reached because the
          // CANCELED case matched first. Do not collapse this back into a single switch on `err.code`.
          let code: String
          if err.domain == "CryptoTokenKit" {
            // -3 is the observed invalidation code. Other CryptoTokenKit failures are token-level
            // faults with no better mapping than the generic bucket.
            code = err.code == -3 ? "KEY_INVALIDATED_REASSOCIATE" : "BIOMETRIC_ERROR"
          } else {
          switch err.code {
          case Int(errSecUserCanceled), LAError.userCancel.rawValue, LAError.systemCancel.rawValue,
               LAError.appCancel.rawValue, LAError.userFallback.rawValue:
            // MEASURED: cancelling the prompt yields com.apple.LocalAuthentication code -2
            // (LAError.userCancel) — this mapping is correct.
            code = "CANCELED"
          case LAError.biometryNotEnrolled.rawValue: code = "NO_BIOMETRICS_ENROLLED"
          case LAError.biometryLockout.rawValue:     code = "LOCKOUT_PERMANENT"
          // A genuinely absent key. Distinct from invalidation (see above) but the same recovery
          // action, and it may be how other iOS versions surface invalidation.
          case Int(errSecItemNotFound):              code = "KEY_INVALIDATED_REASSOCIATE"
          default:                                   code = "BIOMETRIC_ERROR"
          }
          }
        finishPendingSign(pending, outcome: .failure(code: code,
                                                     message: err.localizedDescription, error: err),
                          resolve: resolve, reject: reject)
        return
      }
      do {
        finishPendingSign(pending, outcome: .signature(try derToCompactLowSHex(sig)),
                          resolve: resolve, reject: reject)
      } catch {
        finishPendingSign(pending, outcome: .failure(code: "KEY_ERROR",
                                                     message: error.localizedDescription, error: error),
                          resolve: resolve, reject: reject)
      }
    }
  }

  /// Single completion path: clears the record BEFORE settling (JS may start the next sign the
  /// moment the promise settles), settles exactly once, `done.leave()` last. A cancelled sign can
  /// only reject CANCELED, whatever the system call returned. The identity check tolerates a slot
  /// that `cancelPendingSign` already cleared (or that a newer sign now holds): it then leaves the
  /// slot alone. If the cancel's cap already settled the promise, nothing is settled here.
  private func finishPendingSign(_ pending: PendingSign, outcome: SignOutcome,
                                 resolve: RCTPromiseResolveBlock,
                                 reject: RCTPromiseRejectBlock) {
    pendingSignLock.lock()
    let wasCanceled = pending.canceled
    let alreadySettled = pending.settled
    pending.settled = true
    if pendingSign === pending { pendingSign = nil }
    pendingSignLock.unlock()
    if alreadySettled {
      // cancelPendingSign settled this sign CANCELED when its cap ran out; drop the outcome.
    } else if wasCanceled {
      reject("CANCELED", "signing was cancelled", nil)
    } else {
      switch outcome {
      case .signature(let hex): resolve(["signatureHex": hex])
      case .failure(let code, let message, let error): reject(code, message, error)
      }
    }
    pending.done.leave()
  }

  /// Cancels the pending device-key / recovery-key sign, if any (D-110). Never touches a secret
  /// wrap/unwrap prompt. Resolves `{canceled: true}` only after the sign's JS promise has rejected
  /// CANCELED, as the spec says.
  ///
  /// Like Android's `take()`, the slot is cleared under the lock at once (review WR-03), so the
  /// next sign can never be refused PROMPT_BUSY because this one's system call is slow to return.
  /// `canceled = true` (set in the same lock) guarantees the old sign can only reject CANCELED.
  /// `invalidate()` normally ends `SecKeyCreateSignature` with LAError.appCancel within the 2 s
  /// wait (unproven on device). If the cap runs out first, the promise is rejected CANCELED here
  /// (settle-once through `settled`), and `finishPendingSign` later drops the real outcome.
  ///
  /// Serial-queue implication: if the old system call is still running after the cap, a new
  /// sign's block waits behind it on the serial `signQueue` (it is not refused), so its prompt
  /// only appears once the old Face ID / passcode sheet is answered or times out.
  @objc(cancelPendingSign:rejecter:)
  func cancelPendingSign(_ resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
    pendingSignLock.lock()
    let pending = pendingSign
    pending?.canceled = true
    pendingSign = nil
    pendingSignLock.unlock()
    guard let pending = pending else {
      resolve(["canceled": false])
      return
    }
    pending.context.invalidate()
    if pending.done.wait(timeout: .now() + .seconds(2)) == .timedOut {
      NSLog("AttestationNative.cancelPendingSign: sign did not settle within the 2 s cap")
      pendingSignLock.lock()
      let settleHere = !pending.settled
      pending.settled = true
      pendingSignLock.unlock()
      if settleHere {
        pending.reject("CANCELED", "signing was cancelled", nil)
      }
    }
    resolve(["canceled": true])
  }

  // MARK: - Secret wrap (D-42)
  //
  // Generic, alias-keyed AES-256-GCM secret-at-rest wrap — distinct from every P-256 key above.
  // The wrap key is a Keychain-protected AES-256 key, NOT a Secure Enclave key: the Secure
  // Enclave holds only EC P-256 keys (there is no `kSecAttrKeyTypeAES`). Used through CryptoKit.
  // Unproven on device — D-23 proof debt; a clean typecheck is not working Keychain behaviour.

  private static let secretWrapService = "org.votetorrent.secretwrap"
  private let secretWrapQueue = DispatchQueue(label: "org.votetorrent.secretwrap")
  private static let wrapKeyAliasPattern = try! NSRegularExpression(pattern: "^VOTETORRENT_[A-Z0-9_]+_WRAP_KEY_V[0-9]+$")

  private func isValidWrapKeyAlias(_ alias: String) -> Bool {
    let range = NSRange(alias.startIndex..<alias.endIndex, in: alias)
    return Self.wrapKeyAliasPattern.firstMatch(in: alias, range: range) != nil
  }

  private enum SecretWrapNativeError: Error {
    case code(String, String)
  }

  /// Reads the stored policy marker ("auth=1"/"auth=0") for [alias] WITHOUT prompting —
  /// `interactionNotAllowed = true` mirrors `probeKeyLiveness`'s no-UI probe above. Returns nil if
  /// no item exists yet.
  private func readWrapKeyPolicyMarker(alias: String) -> String? {
    let context = LAContext()
    context.interactionNotAllowed = true
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.secretWrapService,
      kSecAttrAccount as String: alias,
      kSecReturnAttributes as String: true,
      kSecUseAuthenticationContext as String: context
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let attrs = item as? [String: Any],
          let label = attrs[kSecAttrLabel as String] as? String else {
      return nil
    }
    return label
  }

  /// Does an item exist under [alias]? A no-UI attributes-only probe (no data, no prompt). Used on
  /// the unwrap path when the policy marker read returned nil, so an invalidated
  /// `.biometryCurrentSet` item is still known to exist and its data read's errSecItemNotFound can
  /// be reported KEY_INVALIDATED instead of the replaceable NO_WRAP_KEY. errSecSuccess and
  /// errSecInteractionNotAllowed (present but withheld without UI) count as present; only
  /// errSecItemNotFound counts as absent. Any other status is treated as absent, which leaves the
  /// data read to decide exactly as before.
  private func wrapKeyItemExists(alias: String) -> Bool {
    let context = LAContext()
    context.interactionNotAllowed = true
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.secretWrapService,
      kSecAttrAccount as String: alias,
      kSecReturnAttributes as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecUseAuthenticationContext as String: context
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    return status == errSecSuccess || status == errSecInteractionNotAllowed
  }

  /// Loads the wrap key under [alias], keyed by `service` + `kSecAttrAccount == alias`, creating it
  /// only when [createIfMissing] is true (wrap). NEVER updates or overwrites an existing item — a
  /// policy mismatch is rejected, never reconciled (T-62-08-11). Returns the raw 32-byte AES key.
  /// [reason] becomes the Keychain prompt's `localizedReason` (the caller's promptSubtitle).
  private func loadWrapKey(alias: String, requireAuth: Bool, createIfMissing: Bool, reason: String) throws -> Data {
    guard isValidWrapKeyAlias(alias) else {
      throw SecretWrapNativeError.code("INVALID_ARGUMENT", "invalid wrap key alias: \(alias)")
    }

    let wantedMarker = requireAuth ? "auth=1" : "auth=0"
    // CR-02: true once we know an item already exists under the alias (marker read, or a duplicate on
    // add). A `.biometryCurrentSet` item that then reads as errSecItemNotFound was invalidated by a
    // biometric enrollment change, and is reported KEY_INVALIDATED rather than NO_WRAP_KEY.
    var itemExisted = false
    if let existingMarker = readWrapKeyPolicyMarker(alias: alias) {
      itemExisted = true
      if existingMarker != wantedMarker {
        throw SecretWrapNativeError.code(
          "WRAP_KEY_POLICY_MISMATCH",
          "alias \(alias) was created with \(existingMarker), but this call requested \(wantedMarker)"
        )
      }
    } else if createIfMissing {
      var randomBytes = [UInt8](repeating: 0, count: 32)
      guard SecRandomCopyBytes(kSecRandomDefault, 32, &randomBytes) == errSecSuccess else {
        throw SecretWrapNativeError.code("WRAP_FAILED", "SecRandomCopyBytes failed")
      }
      let keyData = Data(randomBytes)

      var addQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: Self.secretWrapService,
        kSecAttrAccount as String: alias,
        kSecAttrLabel as String: wantedMarker,
        kSecAttrSynchronizable as String: false,
        kSecValueData as String: keyData
      ]
      if requireAuth {
        var accessError: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
          kCFAllocatorDefault,
          kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
          .biometryCurrentSet,
          &accessError
        ) else {
          throw accessError!.takeRetainedValue() as Error
        }
        addQuery[kSecAttrAccessControl as String] = access
      } else {
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      }

      let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
      // A concurrent create lost the race — re-read rather than treat as a failure. NEVER update
      // or overwrite an existing item (T-62-08-03).
      if addStatus == errSecDuplicateItem {
        itemExisted = true
      } else if addStatus != errSecSuccess {
        throw SecretWrapNativeError.code("WRAP_FAILED", "SecItemAdd failed with OSStatus \(addStatus)")
      }
    } else {
      // Unwrap with a nil marker: learn whether the item exists without reading its data, so an
      // invalidated item is reported KEY_INVALIDATED below rather than replaceable NO_WRAP_KEY.
      itemExisted = wrapKeyItemExists(alias: alias)
    }
    // A nil marker with createIfMissing == false (unwrap) deliberately falls through to the data read
    // below. It must NOT throw NO_WRAP_KEY early: the marker read is no-UI and can spuriously return
    // nil for an item that exists, and the JS callers treat NO_WRAP_KEY as replaceable, so an early
    // throw could overwrite a saved vote or identity. The data read decides: a present one is
    // decrypted; errSecItemNotFound is KEY_INVALIDATED when the existence probe above saw the item
    // (an invalidated auth-required item), and NO_WRAP_KEY only when it did not.

    var readQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.secretWrapService,
      kSecAttrAccount as String: alias,
      kSecReturnData as String: true
    ]
    if requireAuth {
      let context = LAContext()
      // The caller's promptSubtitle is the localizedReason — iOS has no separate title/subtitle/negative
      // button surface for a Keychain item read the way BiometricPrompt does. An empty reason keeps
      // the empty string (iOS then shows its default).
      context.localizedReason = reason
      readQuery[kSecUseAuthenticationContext as String] = context
    }
    var item: CFTypeRef?
    let status = SecItemCopyMatching(readQuery as CFDictionary, &item)
    guard status == errSecSuccess, let data = item as? Data else {
      if status == errSecItemNotFound {
        // CR-02: an auth-required item that exists but cannot be found on a data read is the
        // reported iOS behaviour of an invalidated `.biometryCurrentSet` item (unproven on device).
        if requireAuth && itemExisted {
          throw SecretWrapNativeError.code("KEY_INVALIDATED", "wrap key under alias \(alias) was invalidated")
        }
        throw SecretWrapNativeError.code("NO_WRAP_KEY", "no wrap key under alias \(alias)")
      }
      throw mapOSStatusOrLAError(status)
    }
    return data
  }

  private func mapOSStatusOrLAError(_ status: OSStatus) -> SecretWrapNativeError {
    switch status {
    case errSecItemNotFound:
      return .code("NO_WRAP_KEY", "no wrap key present")
    case errSecInteractionNotAllowed:
      return .code("DEVICE_LOCKED", "device is locked")
    case errSecUserCanceled, OSStatus(LAError.userCancel.rawValue), OSStatus(LAError.systemCancel.rawValue),
         OSStatus(LAError.appCancel.rawValue), OSStatus(LAError.userFallback.rawValue):
      return .code("CANCELED", "authentication cancelled")
    case OSStatus(LAError.biometryNotEnrolled.rawValue):
      return .code("NO_BIOMETRICS_ENROLLED", "no biometrics enrolled")
    case OSStatus(LAError.biometryLockout.rawValue):
      return .code("LOCKOUT_PERMANENT", "biometry locked out")
    default:
      return .code("WRAP_FAILED", "Keychain operation failed with OSStatus \(status)")
    }
  }

  private func zeroize(_ data: inout Data) {
    data.withUnsafeMutableBytes { raw in
      guard let base = raw.baseAddress else { return }
      memset(base, 0, raw.count)
    }
  }

  /// Answers `wrapSecret`. `promptTitle`/`promptNegativeButton` are accepted for ABI parity with
  /// Android (used only when `requireAuth` is true, which iOS surfaces via `promptSubtitle` as
  /// the Keychain read's `LAContext.localizedReason` — there is no separate title/negative-button
  /// surface for a Keychain item read the way `BiometricPrompt` has one).
  ///
  /// D-14 (63-16): `authWindowSeconds` is accepted for ABI parity and deliberately IGNORED. iOS keeps
  /// the per-use `.biometryCurrentSet` item with a fresh `LAContext` per call, so Submit costs two
  /// prompts on iOS by design (D-14 accept-two; an iOS window is unproven and its device proof is
  /// deferred).
  @objc(wrapSecret:plaintextBase64:aadBase64:requireAuth:promptTitle:promptSubtitle:promptNegativeButton:authWindowSeconds:resolver:rejecter:)
  func wrapSecret(_ keyAlias: String,
                  plaintextBase64: String,
                  aadBase64: String,
                  requireAuth: Bool,
                  promptTitle: String,
                  promptSubtitle: String,
                  promptNegativeButton: String,
                  authWindowSeconds: Double,
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    secretWrapQueue.async {
      guard let plaintext = Data(base64Encoded: plaintextBase64) else {
        reject("INVALID_ENCODING", "plaintextBase64 did not decode", nil); return
      }
      guard let aad = Data(base64Encoded: aadBase64) else {
        reject("INVALID_ENCODING", "aadBase64 did not decode", nil); return
      }
      do {
        var keyData = try self.loadWrapKey(alias: keyAlias, requireAuth: requireAuth, createIfMissing: true, reason: promptSubtitle)
        defer { self.zeroize(&keyData) }
        let sealed = try AES.GCM.seal(plaintext, using: SymmetricKey(data: keyData), nonce: AES.GCM.Nonce(), authenticating: aad)
        let ciphertext = sealed.ciphertext + sealed.tag
        let iv = Data(sealed.nonce)
        resolve([
          "ciphertextBase64": ciphertext.base64EncodedString(),
          "ivBase64": iv.base64EncodedString(),
          "keyAlias": keyAlias,
          "securityLevel": "keychain"
        ])
      } catch let SecretWrapNativeError.code(code, message) {
        reject(code, message, nil)
      } catch {
        reject("WRAP_FAILED", error.localizedDescription, error)
      }
    }
  }

  /// Answers `unwrapSecret`. Same prompt-surface note as `wrapSecret` above. Unwrap never creates a
  /// key (parity with Android `SecretWrapHelper.unwrap`): an absent item rejects NO_WRAP_KEY with no
  /// Keychain write. `promptSubtitle` is forwarded as the Keychain prompt's reason.
  @objc(unwrapSecret:ciphertextBase64:ivBase64:aadBase64:requireAuth:promptTitle:promptSubtitle:promptNegativeButton:authWindowSeconds:resolver:rejecter:)
  func unwrapSecret(_ keyAlias: String,
                    ciphertextBase64: String,
                    ivBase64: String,
                    aadBase64: String,
                    requireAuth: Bool,
                    promptTitle: String,
                    promptSubtitle: String,
                    promptNegativeButton: String,
                    authWindowSeconds: Double,
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
    secretWrapQueue.async {
      guard let combined = Data(base64Encoded: ciphertextBase64), combined.count >= 16 else {
        reject("INVALID_ENCODING", "ciphertextBase64 did not decode to at least 16 bytes", nil); return
      }
      guard let iv = Data(base64Encoded: ivBase64), iv.count == 12 else {
        reject("INVALID_ENCODING", "ivBase64 must decode to 12 bytes", nil); return
      }
      guard let aad = Data(base64Encoded: aadBase64) else {
        reject("INVALID_ENCODING", "aadBase64 did not decode", nil); return
      }
      if !self.isValidWrapKeyAlias(keyAlias) {
        reject("INVALID_ARGUMENT", "invalid wrap key alias: \(keyAlias)", nil); return
      }
      do {
        var keyData = try self.loadWrapKey(alias: keyAlias, requireAuth: requireAuth, createIfMissing: false, reason: promptSubtitle)
        defer { self.zeroize(&keyData) }
        let ciphertext = combined.prefix(combined.count - 16)
        let tag = combined.suffix(16)
        let sealedBox = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: ciphertext, tag: tag)
        let plaintext = try AES.GCM.open(sealedBox, using: SymmetricKey(data: keyData), authenticating: aad)
        resolve(["plaintextBase64": plaintext.base64EncodedString()])
      } catch let SecretWrapNativeError.code(code, message) {
        reject(code, message, nil)
      } catch let error as CryptoKitError {
        // Domain-specific: only `.authenticationFailure` is a GCM tag mismatch; other
        // CryptoKitError cases (e.g. incorrectParameterSize) are not.
        if case .authenticationFailure = error {
          reject("UNWRAP_TAG_MISMATCH", "GCM authentication failed", nil)
        } else {
          reject("UNWRAP_FAILED", "\(error)", nil)
        }
      } catch {
        reject("UNWRAP_FAILED", error.localizedDescription, error)
      }
    }
  }

  // MARK: - Phase 63 review: wrap-key replacement, secure screen, sensitive copy

  /// CR-02: the ONLY aliases `deleteWrapKey` may delete (the vote-record family). Must equal
  /// `DELETABLE_WRAP_KEY_ALIAS_PATTERN` in SecretWrapHelper.kt and `VOTE_RECORD_WRAP_KEY_ALIAS_PATTERN`
  /// in secret-wrap.ts.
  private static let deletableWrapKeyAliasPattern = try! NSRegularExpression(pattern: "^VOTETORRENT_VOTE_RECORD_WRAP_KEY_V[0-9]+$")

  /// CR-02: deletes the wrap-key item under `keyAlias` so the next `wrapSecret` creates a fresh one.
  /// Refuses every alias outside the vote-record family before touching the Keychain. Deletion needs
  /// no authentication, so an invalidated item is deletable. Resolves `["deleted": Bool]`.
  @objc(deleteWrapKey:resolver:rejecter:)
  func deleteWrapKey(_ keyAlias: String,
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
    secretWrapQueue.async {
      let range = NSRange(keyAlias.startIndex..<keyAlias.endIndex, in: keyAlias)
      guard Self.deletableWrapKeyAliasPattern.firstMatch(in: keyAlias, range: range) != nil else {
        reject("INVALID_ARGUMENT", "alias \(keyAlias) may not be deleted", nil); return
      }
      let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: Self.secretWrapService,
        kSecAttrAccount as String: keyAlias
      ]
      let status = SecItemDelete(query as CFDictionary)
      if status == errSecSuccess {
        resolve(["deleted": true])
      } else if status == errSecItemNotFound {
        resolve(["deleted": false])
      } else {
        reject("WRAP_FAILED", "SecItemDelete failed with OSStatus \(status)", nil)
      }
    }
  }

  /// CR-01: iOS has no FLAG_SECURE. Resolves `["applied": false]`; the receipt screen renders its own
  /// opaque privacy cover on AppState 'inactive' instead.
  @objc(setSecureScreen:resolver:rejecter:)
  func setSecureScreen(_ enabled: Bool,
                       resolver resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(["applied": false])
  }

  /// WR-03: SYNCHRONOUS (blocking) method. Puts `text` on the general pasteboard as a local-only item
  /// (no Universal Clipboard) that expires after 60 s. The write is dispatched to the main queue;
  /// `setItems` has no failure signal, so this returns true once the write is scheduled.
  @objc(copySensitiveText:)
  func copySensitiveText(_ text: String) -> NSNumber {
    DispatchQueue.main.async {
      UIPasteboard.general.setItems(
        [["public.utf8-plain-text": text]],
        options: [
          UIPasteboard.OptionsKey.localOnly: true,
          UIPasteboard.OptionsKey.expirationDate: Date().addingTimeInterval(60)
        ]
      )
    }
    return NSNumber(value: true)
  }

  // MARK: - Plan 62-75 file share (D-36)

  /// Writes UTF-8 `contents` to `NSTemporaryDirectory()/vt-share/<fileName>`, emptying the directory
  /// first. Resolves `["uri": file URL string]`. Name rule mirrors Android and the JS wrapper.
  @objc(writeShareFile:contents:resolver:rejecter:)
  func writeShareFile(_ fileName: String,
                      contents: String,
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
    let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
    let nameOk = !fileName.isEmpty
      && fileName.count <= 100
      && !fileName.contains("..")
      && fileName.unicodeScalars.allSatisfy { allowed.contains($0) }
    if !nameOk {
      reject("INVALID_NAME", "file name must match [A-Za-z0-9._-]{1,100} and not contain '..'", nil); return
    }
    do {
      let fm = FileManager.default
      let dir = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true).appendingPathComponent("vt-share", isDirectory: true)
      try fm.createDirectory(at: dir, withIntermediateDirectories: true)
      for existing in try fm.contentsOfDirectory(atPath: dir.path) {
        try fm.removeItem(at: dir.appendingPathComponent(existing))
      }
      let url = dir.appendingPathComponent(fileName)
      try contents.write(to: url, atomically: true, encoding: .utf8)
      resolve(["uri": url.absoluteString])
    } catch {
      reject("WRITE_FAILED", error.localizedDescription, error)
    }
  }

  /// Plan 62-138: deletes the regular file at the `file://` `uri` iff its symlink-resolved, standardized
  /// path is a strict child of NSCachesDirectory. Resolves `["deleted": Bool]`; rejects OUTSIDE_CACHE /
  /// DELETE_FAILED.
  @objc(deleteCachedFile:resolver:rejecter:)
  func deleteCachedFile(_ uri: String,
                        resolver resolve: @escaping RCTPromiseResolveBlock,
                        rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let url = URL(string: uri), url.isFileURL else {
      reject("OUTSIDE_CACHE", "uri is not a file URL", nil); return
    }
    let fm = FileManager.default
    guard let cachesDir = fm.urls(for: .cachesDirectory, in: .userDomainMask).first else {
      reject("DELETE_FAILED", "no caches directory", nil); return
    }
    let root = cachesDir.resolvingSymlinksInPath().standardizedFileURL.path
    let target = url.resolvingSymlinksInPath().standardizedFileURL.path
    var isDir: ObjCBool = false
    guard target.hasPrefix(root + "/"), fm.fileExists(atPath: target, isDirectory: &isDir), !isDir.boolValue else {
      reject("OUTSIDE_CACHE", "file is not a regular file inside the caches directory", nil); return
    }
    do {
      try fm.removeItem(atPath: target)
      resolve(["deleted": true])
    } catch {
      reject("DELETE_FAILED", error.localizedDescription, error)
    }
  }

  /// Android-only seam. iOS shares through RN `Share.share({ url })`, whose sheet includes Save to Files.
  @objc(shareFile:mimeType:subject:dialogTitle:resolver:rejecter:)
  func shareFile(_ uri: String,
                 mimeType: String,
                 subject: String,
                 dialogTitle: String,
                 resolver resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    reject("UNSUPPORTED", "shareFile is Android-only; on iOS share the file URL through RN Share.share({ url })", nil)
  }
}
