//
//  AttestationNative.m — RCT_EXTERN_MODULE registration shim for AttestationNativeModule.swift.
//
//  WHY THIS FILE EXISTS: AttestationNativeModule.swift is a plain `NSObject` annotated
//  `@objc(AttestationNative)`. Swift alone cannot register a module with React Native — the
//  RCT_EXTERN_MODULE / RCT_EXTERN_METHOD macros are C preprocessor macros and must live in an
//  Objective-C translation unit. Without this file the Swift compiles cleanly, the podspec links
//  it, and `TurboModuleRegistry.getEnforcing('AttestationNative')` still throws at runtime — the
//  failure mode looks like a JS bug, not a missing build file.
//
//  The selectors below must match `@objc(...)` in the Swift EXACTLY, including every argument
//  label and trailing colon. A mismatch is not a compile error: it produces an
//  "unrecognized selector" crash the first time JS calls the method.
//
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE (AttestationNative, NSObject)

RCT_EXTERN_METHOD(provisionDeviceKey:(NSString *)keyAlias
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getCurrentDeviceKey:(NSString *)keyAlias
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(produceAttestation:(NSString *)keyAlias
                  boundDigest:(NSString *)boundDigest
                  assertionDigest:(NSString *)assertionDigest
                  enableDeviceCheck:(BOOL)enableDeviceCheck
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// Spike 104 (R1d) — Android-only; the Swift implementations reject UNSUPPORTED_PLATFORM. Selectors
// must match `@objc(provisionAttestedDeviceKey:attestationChallengeBase64:resolver:rejecter:)` and
// `@objc(produceFreshAttestation:boundDigest:boundDigestUtf8Base64:enablePlayIntegrity:resolver:rejecter:)` EXACTLY.
RCT_EXTERN_METHOD(provisionAttestedDeviceKey:(NSString *)keyAlias
                  attestationChallengeBase64:(NSString *)attestationChallengeBase64
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(produceFreshAttestation:(NSString *)keyAlias
                  boundDigest:(NSString *)boundDigest
                  boundDigestUtf8Base64:(NSString *)boundDigestUtf8Base64
                  enablePlayIntegrity:(BOOL)enablePlayIntegrity
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(signWithDeviceKey:(NSString *)keyAlias
                  digestBase64:(NSString *)digestBase64
                  promptTitle:(NSString *)promptTitle
                  promptSubtitle:(NSString *)promptSubtitle
                  promptNegativeButton:(NSString *)promptNegativeButton
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(provisionRecoveryKey:(NSString *)keyAlias
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(signWithRecoveryKey:(NSString *)keyAlias
                  digestBase64:(NSString *)digestBase64
                  promptTitle:(NSString *)promptTitle
                  promptSubtitle:(NSString *)promptSubtitle
                  promptNegativeButton:(NSString *)promptNegativeButton
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// Selector must match the Swift cancelPendingSign @objc name exactly (mismatch = runtime crash).
RCT_EXTERN_METHOD(cancelPendingSign:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

// D-42 (Phase 62 plan 08) — generic secret-wrap. Selectors must match the Swift
// `@objc(wrapSecret:plaintextBase64:aadBase64:requireAuth:promptTitle:promptSubtitle:
// promptNegativeButton:authWindowSeconds:resolver:rejecter:)` / `@objc(unwrapSecret:ciphertextBase64:ivBase64:
// aadBase64:requireAuth:promptTitle:promptSubtitle:promptNegativeButton:authWindowSeconds:resolver:rejecter:)`
// strings EXACTLY (see this file's header comment).
RCT_EXTERN_METHOD(wrapSecret:(NSString *)keyAlias
                  plaintextBase64:(NSString *)plaintextBase64
                  aadBase64:(NSString *)aadBase64
                  requireAuth:(BOOL)requireAuth
                  promptTitle:(NSString *)promptTitle
                  promptSubtitle:(NSString *)promptSubtitle
                  promptNegativeButton:(NSString *)promptNegativeButton
                  authWindowSeconds:(double)authWindowSeconds
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(unwrapSecret:(NSString *)keyAlias
                  ciphertextBase64:(NSString *)ciphertextBase64
                  ivBase64:(NSString *)ivBase64
                  aadBase64:(NSString *)aadBase64
                  requireAuth:(BOOL)requireAuth
                  promptTitle:(NSString *)promptTitle
                  promptSubtitle:(NSString *)promptSubtitle
                  promptNegativeButton:(NSString *)promptNegativeButton
                  authWindowSeconds:(double)authWindowSeconds
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// Plan 62-75 (D-36) — file share. Selectors must match the Swift `@objc(writeShareFile:contents:
// resolver:rejecter:)` / `@objc(shareFile:mimeType:subject:dialogTitle:resolver:rejecter:)` EXACTLY.
RCT_EXTERN_METHOD(writeShareFile:(NSString *)fileName
                  contents:(NSString *)contents
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(shareFile:(NSString *)uri
                  mimeType:(NSString *)mimeType
                  subject:(NSString *)subject
                  dialogTitle:(NSString *)dialogTitle
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// Plan 62-138. Selector must match the Swift `@objc(deleteCachedFile:resolver:rejecter:)` EXACTLY.
RCT_EXTERN_METHOD(deleteCachedFile:(NSString *)uri
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// Phase 63 review (CR-02, CR-01, WR-03). Selectors must match the Swift `@objc(deleteWrapKey:resolver:
// rejecter:)`, `@objc(setSecureScreen:resolver:rejecter:)` and `@objc(copySensitiveText:)` EXACTLY.
// copySensitiveText is a blocking synchronous method (the codegen spec returns `boolean`).
RCT_EXTERN_METHOD(deleteWrapKey:(NSString *)keyAlias
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setSecureScreen:(BOOL)enabled
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN__BLOCKING_SYNCHRONOUS_METHOD(copySensitiveText:(NSString *)text)

// Keyholder prompt batching. Selectors must match the Swift `@objc(sealSecret:plaintextBase64:resolver:
// rejecter:)` / `@objc(unsealSecret:ciphertextBase64:promptTitle:promptSubtitle:promptNegativeButton:
// resolver:rejecter:)` EXACTLY.
RCT_EXTERN_METHOD(sealSecret:(NSString *)keyAlias
                  plaintextBase64:(NSString *)plaintextBase64
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(unsealSecret:(NSString *)keyAlias
                  ciphertextBase64:(NSString *)ciphertextBase64
                  promptTitle:(NSString *)promptTitle
                  promptSubtitle:(NSString *)promptSubtitle
                  promptNegativeButton:(NSString *)promptNegativeButton
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

+ (BOOL)requiresMainQueueSetup { return NO; }

@end
