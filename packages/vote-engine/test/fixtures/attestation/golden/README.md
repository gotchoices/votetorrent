# Attestation golden fixtures — provenance (D-09)

This directory is a **placeholder**, mirroring the single-source-of-truth
provenance discipline `packages/vote-engine/src/database/digest-vectors.ts`
already establishes for this codebase's other golden-vector class.

## Status: pending real Play Console registration (D-10)

Phase 43's D-10 decision explicitly defers actual Google Play Console
app registration + Cloud project + Integrity-key download. Until an
authority has a real, Play-linked app instance, there is no way to capture
a genuine Play Integrity classic-API token or a genuine Android Keystore
hardware Key Attestation cert chain signed by Google's real hardware root.

This phase (43-02) therefore ships **synthetic-only** coverage
(`../synthetic-jwe.ts`, `../synthetic-key-description.ts`,
`../test-root-ca.ts`) and leaves this `golden/` directory empty except for
this README. A later plan (tracked as a `SETUP.md`/D-10 follow-up) captures
a small set of real-device golden vectors once Play Console registration
exists.

## CI posture

CI runs **synthetic-only**. Nothing in this directory is required for the
test suite to pass, and no test currently reads from `golden/`. When golden
captures are added, they become **committed fixtures** exercised by an
opt-in test path — never a CI-blocking requirement, since golden capture is
gated on external Google Play Console access this codebase does not control.

## Non-negotiable rule when this directory IS populated

Mirroring `digest-vectors.ts`'s own header discipline verbatim:

> The expected values must come from the same code path / real artifact the
> schema constraints (here: the real verifier) use at runtime — **never
> hand-authored**.

Concretely, once populated:

- Every file under `golden/` MUST be a **real device capture** — a genuine
  Play Integrity classic-API JWE-of-JWS token and/or a genuine Keystore
  `KeyDescription` cert chain, captured from an actual Android device
  against Google's real Play Integrity API / hardware attestation root.
- **Do NOT** hand-write, synthesize, or otherwise fabricate a "golden"
  fixture — that defeats the entire purpose of a golden vector (proving
  format fidelity against the real thing, not against this codebase's own
  assumptions about the format).
- Each captured file should record its capture provenance (device model,
  Android version, capture date, Play Integrity API version) in an adjacent
  comment or manifest entry, so a future format drift can be diagnosed
  against a known-good baseline.
- Google's classic API is rate-limited to 5 tokens/minute/app-instance and
  10,000 requests/app/day (Common Pitfall 5, RESEARCH.md) — budget for a
  **handful** of golden captures, not a broad matrix. The synthetic fixtures
  in the parent directory carry the exhaustive branch/negative coverage
  (D-09); golden captures exist only to prove format fidelity against the
  real Google artifacts, not to duplicate that matrix.
