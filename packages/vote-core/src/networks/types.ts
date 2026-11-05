import type { NetworkInit, NetworkReference } from '../network/models'
import type { INetworkEngine } from '../network/types'
import type { User } from '../user/models'
import type { IBuilder } from '../common/builder.js'
import type { Signature } from '../common/signature.js'

export interface INetworksEngine {
  clearRecentNetworks(): Promise<void>
  create(networkInit: NetworkInit, user: User): Promise<INetworkEngine>
  getRecentNetworks(): Promise<NetworkReference[]>
  open(
    ref: NetworkReference,
    user: User | undefined,
    storeAsRecent?: boolean
  ): Promise<INetworkEngine>
  buildCreate(): INetworksCreateBuilder
  /**
   * D-35/62-16: export the network's founding bundle (one row each of User,
   * UserKey, Authority, Admin, Officer and Network, read verbatim from the
   * exporting device's database), signed by a founding officer's own
   * unexpired key. Rejects with a `FoundingBundleExportError` (vote-engine)
   * for the engine's own refusals, including the two signature self-checks,
   * and never returns a partial bundle. A signer error carrying a string
   * `code` (user cancel, lockout, key invalidated) is rethrown unchanged.
   */
  exportFoundingBundle(networkHash: string, exporter: FoundingBundleExporter): Promise<FoundingBundleExport>
  /**
   * D-35/D-38/D-39/62-16: import a founding bundle produced by
   * `exportFoundingBundle` on a second device. Verifies the bundle in a
   * fixed fail-closed order BEFORE any database is opened; never throws for
   * a bundle or target problem — every failure is returned, categorized by
   * `FOUNDING_FAILURE_CATEGORY` (vote-engine).
   */
  importFoundingBundle(
    bundleText: string,
    user: User | undefined,
    options?: FoundingBundleImportOptions
  ): Promise<FoundingBundleImportResult>
  /**
   * 62-102: validity check for the import screen. Parses and verifies a
   * bundle WITHOUT anchors and WITHOUT opening any database; never throws.
   * Deliberately returns neither the digest nor the fingerprint, so a screen
   * cannot show the value the importing officer must type in from the
   * exporter (the anchor must be an independent, out-of-band input).
   */
  inspectFoundingBundle(bundleText: string): Promise<FoundingBundleInspection>
  /**
   * The founding anchor a network join code carries: the four genesis keys
   * and the founding content digest, read from this device's open network
   * exactly as `exportFoundingBundle` reads them, but unsigned. Rejects with
   * a `FoundingBundleExportError` (vote-engine): `network-not-open`,
   * `admin-revised`, `genesis-unreadable`, `not-founding-officer`.
   */
  getFoundingAnchor(networkHash: string, founder: FoundingAnchorFounder): Promise<FoundingAnchor>
  /**
   * The same anchor for a join or pairing code, built from the replicated
   * rows alone so any officer's device can build it, also after an Admin
   * revision. It derives the founding generation itself: the primary
   * authority's earliest Admin generation, that generation's single Officer
   * and that officer's key with the earliest expiration (ties by public key).
   * Rejects with a `FoundingBundleExportError` (vote-engine):
   * `network-not-open`, `genesis-unreadable` or `signer-key-invalid`, never
   * `admin-revised`. `getFoundingAnchor` keeps the D-38 `admin-revised` refusal.
   */
  getJoinAnchor(networkHash: string): Promise<FoundingAnchor>
  /**
   * Spike 100: a voter that was admitted to the authority's cadre opens the
   * network's strand and accepts it only when the replicated founding rows
   * hash to the join code's digest. Never writes founding rows (a voter must
   * not replay genesis into a shared strand), never opens anything while no
   * peer is connected (a peerless open would found a second copy of the
   * network), and never throws for a join problem.
   */
  joinFromStrand(
    anchor: NetworkJoinAnchor,
    user: User | undefined,
    options: JoinFromStrandOptions
  ): Promise<JoinFromStrandResult>
}

export interface INetworksCreateBuilder extends IBuilder<{ networkInit: NetworkInit; user: User }, INetworkEngine> {
  fromPayload(payload: { networkInit: NetworkInit; user: User }): this
}

// ---------------------------------------------------------------------------
// D-35/D-38/D-39 (62-16): founding-bundle contract. Types only — no runtime
// values. Created by 62-16; consumed verbatim by 62-23 (wave 5). Names and
// semantics are locked — see 62-16-PLAN.md <interfaces>.
// ---------------------------------------------------------------------------

/** The six tables a founding bundle carries, in replay order. */
export type FoundingBundleTable = 'User' | 'UserKey' | 'Authority' | 'Admin' | 'Officer' | 'Network'

/** A single cell value carried by a founding-bundle row. */
export type FoundingBundleValue = string | number | null

/** A single founding-bundle row: column name to cell value. */
export type FoundingBundleRow = Readonly<Record<string, FoundingBundleValue>>

/** Every founding table's rows, keyed by table name. Exactly one row per table on a valid bundle. */
export type FoundingBundleRows = Readonly<Record<FoundingBundleTable, readonly FoundingBundleRow[]>>

/** Derived from the six founding rows — the human- and UI-facing summary of the network being shared. */
export interface FoundingBundleDescriptor {
  readonly networkId: string
  /** = H16(networkId) = strandId (D-39). */
  readonly networkHash: string
  readonly relays: readonly string[]
  readonly name: string
  readonly primaryAuthorityId: string
  readonly primaryAuthorityDomainName: string
  readonly imageUrl?: string
}

/** The founding officer's signature over the bundle's signing digest. */
export interface FoundingBundleExporterSignature {
  /** Hex-encoded public key. */
  readonly signerKey: string
  /** Hex-encoded signature. */
  readonly signature: string
  readonly userId: string
}

/** The frozen founding-bundle envelope. */
export interface FoundingBundle {
  readonly format: 'votetorrent-founding-bundle'
  readonly formatVersion: 1
  readonly descriptor: FoundingBundleDescriptor
  /** computeSchemaHash() */
  readonly schemaHash: string
  /** 19-char canonical datetime, self-asserted, signed. */
  readonly exportedAt: string
  readonly manifest: Readonly<Record<FoundingBundleTable, number>>
  /** computeContentDigest(rows), base64url. */
  readonly digest: string
  readonly rows: FoundingBundleRows
  readonly exporter: FoundingBundleExporterSignature
}

/** The app-supplied signer for `exportFoundingBundle`. */
export interface FoundingBundleExporter {
  readonly userId: string
  /** Hex public key; must be one of userId's UserKey rows, unexpired. */
  readonly signerKey: string
  readonly sign: (digest: Uint8Array) => Promise<Signature>
}

/** The result of a successful `exportFoundingBundle` call. */
export interface FoundingBundleExport {
  readonly bundle: FoundingBundle
  /** serializeFoundingBundle(bundle): what 62-23 shares via the OS share sheet. */
  readonly text: string
  readonly fileName: string
  /** 62-102: foundingBundleFingerprint(bundle.digest), for the exporter to read out to the importing officer. */
  readonly fingerprint: string
}

/** 62-102: result of `inspectFoundingBundle`. The ok branch deliberately carries no digest or fingerprint. */
export type FoundingBundleInspection =
  | { readonly ok: true; readonly networkName: string }
  | {
      readonly ok: false
      readonly reason: FoundingBundleFailureReason
      readonly category: FoundingBundleFailureCategory
      readonly detail: string
    }

/** Every way `exportFoundingBundle` can refuse. */
export type FoundingBundleExportErrorCode =
  | 'network-not-open'
  | 'genesis-unreadable'
  | 'admin-revised'
  | 'not-founding-officer'
  | 'signer-key-invalid'
  | 'signature-self-check'

/** Every way `verifyFoundingBundle`/`importFoundingBundle` can refuse a bundle or target. */
export type FoundingBundleFailureReason =
  | 'malformed'
  | 'format-version-mismatch'
  | 'schema-hash-mismatch'
  | 'manifest-mismatch'
  | 'digest-mismatch'
  | 'row-inconsistent'
  | 'descriptor-mismatch'
  | 'exporter-not-founding-officer'
  | 'signature-invalid'
  | 'anchor-required'
  | 'anchor-mismatch'
  | 'replay-rejected'
  | 'target-conflict'
  | 'target-open-failed'
  | 'target-replay-failed'

/** UI-facing bucket every `FoundingBundleFailureReason` maps to (fixed by `FOUNDING_FAILURE_CATEGORY` in vote-engine). */
export type FoundingBundleFailureCategory = 'invalid-bundle' | 'error'

/** Out-of-band anchors a caller may supply to `verifyFoundingBundle`/`importFoundingBundle` (Phase 50 VerifySnapshotOptions pattern). */
export interface FoundingBundleImportOptions {
  /**
   * At least one anchor (this, `expectedDigest` or `expectedFingerprint`) is
   * REQUIRED by `importFoundingBundle`: without one it returns
   * `anchor-required` (D-36 out-of-band confirmation; initial/G2 WR-03).
   * There is no bypass flag; the app passes `expectedFingerprint`.
   */
  readonly expectedNetworkHash?: string
  readonly expectedDigest?: string
  /** The fingerprint the importing officer typed from the exporter's screen (case, spaces and dashes are ignored). */
  readonly expectedFingerprint?: string
  /** Forwarded to open(). */
  readonly getPeerCount?: () => number
}

/** The non-throwing result of `importFoundingBundle`. */
export type FoundingBundleImportResult =
  | {
      readonly ok: true
      readonly outcome: 'replayed' | 'already-present'
      /** 62-102: the bundle's fingerprint, for the record. */
      readonly fingerprint: string
      readonly networkRef: NetworkReference
      readonly network: INetworkEngine
    }
  | {
      readonly ok: false
      readonly reason: 'already-joined'
      readonly category: 'already-joined'
      readonly networkRef: NetworkReference
    }
  | {
      readonly ok: false
      readonly reason: FoundingBundleFailureReason
      readonly category: FoundingBundleFailureCategory
      readonly detail: string
    }

// ---------------------------------------------------------------------------
// Spike 100: joining an authority's network from a join code. The code
// carries a cadre invitation plus this anchor; the anchor is checked against
// the founding rows the voter's strand replicates, never replayed.
// ---------------------------------------------------------------------------

/** The point lookups that select a network's six founding rows (vote-engine `GenesisRowKeys`). */
export interface FoundingGenesisKeys {
  readonly userId: string
  readonly signerKey: string
  readonly authorityId: string
  readonly adminEffectiveAt: string
}

/** Whose founding rows `getFoundingAnchor` reads: the founding officer's user id and an active key. */
export interface FoundingAnchorFounder {
  readonly userId: string
  readonly signerKey: string
}

/** What `getFoundingAnchor` returns: enough to verify a replicated network without its bundle. */
export interface FoundingAnchor {
  readonly networkHash: string
  readonly name: string
  readonly genesis: FoundingGenesisKeys
  /** computeContentDigest(founding rows), base64url — the same digest a founding bundle carries. */
  readonly digest: string
  /** foundingBundleFingerprint(digest): what a voter compares against the authority's published value. */
  readonly fingerprint: string
}

/** The network half of a join code: which strand to open and what its founding rows must hash to. */
export interface NetworkJoinAnchor {
  readonly networkHash: string
  /** Display only until verified; the network's own Network row names it once joined. */
  readonly name: string
  readonly genesis: FoundingGenesisKeys
  readonly digest: string
}

export interface JoinFromStrandOptions {
  /**
   * Live CONTROL-network connection count — the signal the app's strand DbFactory reads to
   * decide whether it is the strand's founder. 0 means "do not open anything yet": a strand
   * opened with no peer connected is founded locally, a second copy of the network.
   */
  readonly getPeerCount: () => number
  /** Forwarded to open() as its statistics peer-count source (the strand's own peer count). */
  readonly getStrandPeerCount?: () => number
  /** How long to wait for the founding rows to replicate before answering `not-synced`. Default 60 s. */
  readonly timeoutMs?: number
  /** Poll interval while waiting. Default 500 ms. */
  readonly pollMs?: number
  /** Called once, when all six founding rows have arrived and the digest check is about to run. */
  readonly onVerifying?: () => void
}

/** Every way `joinFromStrand` can decline. `no-peers` and `not-synced` are retryable. */
export type JoinFromStrandFailureReason =
  | 'no-peers'
  | 'not-synced'
  | 'digest-mismatch'
  | 'target-open-failed'

export type JoinFromStrandResult =
  | {
      readonly ok: true
      readonly outcome: 'joined' | 'already-joined'
      readonly networkRef: NetworkReference
      readonly fingerprint: string
    }
  | {
      readonly ok: false
      readonly reason: JoinFromStrandFailureReason
      readonly retryable: boolean
      readonly detail: string
    }
