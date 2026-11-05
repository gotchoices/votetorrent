//
//  SignatureEncoding.swift — DER → compact low-S conversion for P-256 ECDSA signatures.
//
//  Extracted from AttestationNativeModule as free functions specifically so it can be UNIT TESTED
//  on the host without an iPhone. This is the highest-risk code in the iOS module: hand-rolled DER
//  parsing plus hand-rolled 256-bit modular arithmetic, and every failure mode is silent — a wrong
//  result surfaces as an ordinary "invalid signature" from @noble/curves, never as a crash.
//
//  CONTRACT (must match packages/attestation-native/src/specs/NativeAttestation.ts):
//    64-byte compact `r‖s`, `s` normalized into the LOWER half of the P-256 group order,
//    hex-encoded. The SHAPE matches @noble/curves v2 `verify()` defaults (lowS:true,
//    format:'compact'); the hashed domain (prehash) is the caller's concern — iOS signs its input
//    as the final hash (prehash:false), see native-sign-input.ts. Callers must NOT re-normalize.
//
//  Android's Keystore returns this shape already. iOS SecKeyCreateSignature returns DER with S
//  UN-normalized, so this conversion is load-bearing on iOS and has no Android counterpart.
//

import Foundation

public enum SignatureEncodingError: Error, CustomStringConvertible {
  case malformedDER(String)
  public var description: String {
    switch self {
    case .malformedDER(let m): return "malformed DER signature: \(m)"
    }
  }
}

/// The P-256 group order n, big-endian.
let p256Order: [UInt8] = [
  0xff,0xff,0xff,0xff,0x00,0x00,0x00,0x00,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,
  0xbc,0xe6,0xfa,0xad,0xa7,0x17,0x9e,0x84,0xf3,0xb9,0xca,0xc2,0xfc,0x63,0x25,0x51
]

/// n >> 1, computed once. `s` is "high" iff `s > halfOrder`.
func halfOrder(_ n: [UInt8]) -> [UInt8] {
  var half = [UInt8](repeating: 0, count: 32)
  var carry: UInt8 = 0
  for i in 0..<32 {
    half[i] = (n[i] >> 1) | (carry << 7)
    carry = n[i] & 1
  }
  return half
}

/// Big-endian 32-byte compare: returns true iff a > b.
func isGreaterThan(_ a: [UInt8], _ b: [UInt8]) -> Bool {
  for i in 0..<32 where a[i] != b[i] { return a[i] > b[i] }
  return false
}

/// Big-endian 32-byte subtraction a - b (assumes a >= b).
func subtract256(_ a: [UInt8], _ b: [UInt8]) -> [UInt8] {
  var out = [UInt8](repeating: 0, count: 32)
  var borrow = 0
  for i in stride(from: 31, through: 0, by: -1) {
    let diff = Int(a[i]) - Int(b[i]) - borrow
    out[i] = UInt8(diff & 0xff)
    borrow = diff < 0 ? 1 : 0
  }
  return out
}

/// Parse `SEQUENCE { INTEGER r, INTEGER s }`, normalize S low, return 64-byte compact hex.
public func derToCompactLowSHex(_ der: Data) throws -> String {
  let bytes = [UInt8](der)
  var idx = 0

  // Separate guards: a short buffer and a wrong tag are different faults, and conflating them
  // reports "expected SEQUENCE tag 0x30" for input that plainly starts with 0x30 — misleading in
  // exactly the situation where a legible reason matters most.
  guard !bytes.isEmpty else {
    throw SignatureEncodingError.malformedDER("empty input")
  }
  guard bytes[0] == 0x30 else {
    throw SignatureEncodingError.malformedDER("expected SEQUENCE tag 0x30, got 0x\(String(format: "%02x", bytes[0]))")
  }
  guard bytes.count >= 8 else {
    throw SignatureEncodingError.malformedDER("buffer too short for an ECDSA signature (\(bytes.count) bytes)")
  }
  // DER length may be short-form (< 0x80) or long-form. ECDSA P-256 signatures are always
  // short-form (max ~70 bytes), but handle 0x81 defensively rather than mis-parsing.
  idx = 1
  let seqLen: Int
  if bytes[idx] == 0x81 {
    idx += 1
    seqLen = Int(bytes[idx]); idx += 1
  } else if bytes[idx] < 0x80 {
    seqLen = Int(bytes[idx]); idx += 1
  } else {
    throw SignatureEncodingError.malformedDER("unsupported long-form length")
  }
  guard idx + seqLen == bytes.count else {
    throw SignatureEncodingError.malformedDER("SEQUENCE length \(seqLen) does not match buffer (\(bytes.count - idx) remaining)")
  }

  func readInteger() throws -> [UInt8] {
    guard idx < bytes.count, bytes[idx] == 0x02 else {
      throw SignatureEncodingError.malformedDER("expected INTEGER tag 0x02 at offset \(idx)")
    }
    idx += 1
    guard idx < bytes.count else { throw SignatureEncodingError.malformedDER("truncated INTEGER length") }
    let len = Int(bytes[idx]); idx += 1
    guard len > 0, idx + len <= bytes.count else {
      throw SignatureEncodingError.malformedDER("INTEGER length \(len) runs past the buffer")
    }
    var v = Array(bytes[idx..<(idx + len)]); idx += len
    // DER encodes INTEGERs signed, so a value with the high bit set carries a leading 0x00.
    while v.count > 32, v.first == 0x00 { v.removeFirst() }
    guard v.count <= 32 else { throw SignatureEncodingError.malformedDER("INTEGER wider than 32 bytes") }
    while v.count < 32 { v.insert(0x00, at: 0) }   // left-pad short values
    return v
  }

  let r = try readInteger()
  var s = try readInteger()
  guard idx == bytes.count else {
    throw SignatureEncodingError.malformedDER("\(bytes.count - idx) trailing bytes after s")
  }

  if isGreaterThan(s, halfOrder(p256Order)) {
    s = subtract256(p256Order, s)
  }

  return (r + s).map { String(format: "%02x", $0) }.joined()
}
