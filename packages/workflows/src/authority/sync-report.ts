/**
 * sync-report.ts — the association-sync contract shared by the Authority app and the vt CLI.
 *
 * Moved from `apps/VoteTorrentAuthority/src/screens/registration/bulk-import-sync-model.ts` by 67-09;
 * that file re-exports these names and keeps its registry, `SyncBindingId`, `SyncBindingHandle` and
 * the screen view-model. This file has no import of any kind: it is plain TypeScript, so the shared
 * peer binding (`attach-peer-sync-binding.ts`) can depend on it without reaching into an app file.
 */

/**
 * What a binding's `syncNow()` resolves to. `errorItemIds` is an array of `string` and NOT a
 * record type — there is structurally no field through which a payload value, a requester name,
 * or an HTTP response body could travel from a transport to this screen. A host adapting 48-09's
 * `skipped` accumulator or 48-10's non-2xx error mapping takes the filename / item id and drops
 * everything else. Do NOT widen this to carry a `reason`, a `message`, or a `detail` — doing so
 * would reopen exactly the leak 48-10 closed at the binding.
 */
export interface TransportSyncReport {
  syncedAt: string
  imported: number
  pending: number
  errorItemIds: readonly string[]
}

/**
 * 62-21 (D-32): an optional context a binding's `syncNow`/`readCounts` may need — currently just
 * `authorityId`, since the peer binding's transports and signer all scope to one authority. The
 * filesystem/REST bindings ignore it (their own `syncNow` closures already capture everything they
 * need at attach time).
 */
export interface SyncBindingContext {
  authorityId: string
}

/**
 * 62-21 (D-31): numbers only — the SAME T-48-20-02 PII rule `TransportSyncReport.errorItemIds`
 * already follows. `pending`/`synced`/`failed` never carry a requester name, a payload value, or a
 * transport error string.
 */
export interface PeerSyncCounts {
  pending: number
  synced: number
  failed: number
}

/**
 * WR-07 helper: resolve an optional "already imported" predicate to a plain boolean.
 * An absent predicate means "unknown", and so does one that throws — both fall through to
 * attempting the submit, which is the pre-WR-07 behaviour. Only an explicit `true` skips.
 */
async function skipsAsAlreadyImported<TDoc>(
  predicate: ((doc: TDoc) => Promise<boolean>) | undefined,
  doc: TDoc,
): Promise<boolean> {
  if (!predicate) return false
  try {
    return await predicate(doc)
  } catch {
    return false
  }
}

/**
 * The D-19 ordering/pre-filter discipline (T-51-10-09), extracted as a pure,
 * plain-TypeScript helper so it is directly unit-testable without a
 * renderer, an engine, or a network call — `attach-association-sync-bindings.ts`
 * supplies the real staged-document reads, the real engine submit calls, and
 * the real driver call; this function owns only the ORDER and the
 * unconditional-driver-call guarantee.
 *
 * ORDERING, AND WHAT IS AND IS NOT LOAD-BEARING: `submitRequest` and
 * `submitAttestation` STAGE and PRE-FILTER only; they mutate nothing in the
 * transport intake a caller's `processPending` reads from, so a real driver
 * (`processPendingAssociationRequests`, 51-09) independently RE-READS and
 * RE-VALIDATES every staged document through its own
 * `validateStagedAttestationAnswer` check (51-08). A pre-filter rejection
 * here therefore does not — and must not be read as — preventing the driver
 * from seeing the document. `processPending` is called EXACTLY ONCE,
 * UNCONDITIONALLY, after both loops — regardless of whether either loop
 * produced an error. Do NOT add a branch that skips `processPending` when
 * `errorItemIds` is non-empty: that is precisely how a security check
 * becomes correct code the running app never reaches.
 *
 * Both staged-read calls are independently fail-conservative: a rejected
 * `readStagedRequests`/`readStagedAttestations` is treated as an empty
 * batch (an honest, empty sync), never a thrown error that would abort the
 * unconditional `processPending` call below.
 *
 * WR-07 (51-REVIEW) — RE-OFFERED DOCUMENTS ARE NOT ERRORS. The staged reads
 * take no cursor and nothing ever deletes a staged document, so EVERY
 * document ever staged is re-offered on EVERY sync. Without the two optional
 * `alreadyImported*` predicates below, the second press of "Sync Now"
 * reported the first press's successful import as a sync ERROR — a duplicate
 * primary key on the request leg, a `Status !== 'c'` rejection on the
 * attestation leg — and kept doing so forever, for every previously-imported
 * document, drowning the genuine-error signal from the second press onward.
 *
 * A predicate returning `true` makes the document a silent no-op: neither
 * counted as an import nor recorded as an error, because neither is true of
 * a document a previous run already handled. Supplying them is OPTIONAL and
 * omitting them preserves the old behaviour exactly. A predicate that THROWS
 * is treated as "unknown" and the submit is attempted as before — a broken
 * predicate must never silently swallow a document.
 */
export async function runAssociationSync<TReq, TAtt>(params: {
  readStagedRequests: () => Promise<readonly TReq[]>
  readStagedAttestations: () => Promise<readonly TAtt[]>
  requestIdOf: (doc: TReq) => string
  attestationIdOf: (doc: TAtt) => string
  submitRequest: (doc: TReq) => Promise<unknown>
  submitAttestation: (doc: TAtt) => Promise<unknown>
  processPending: () => Promise<unknown>
  /** WR-07: true when a previous sync already imported this request — skip, do not error. */
  alreadyImportedRequest?: (doc: TReq) => Promise<boolean>
  /** WR-07: true when this attestation is not actionable now (already decided, or not yet
   * challenged) — skip, do not error. The driver re-reads every staged document regardless. */
  alreadyImportedAttestation?: (doc: TAtt) => Promise<boolean>
}): Promise<TransportSyncReport> {
  const errorItemIds: string[] = []
  let imported = 0

  let stagedRequests: readonly TReq[] = []
  try {
    stagedRequests = await params.readStagedRequests()
  } catch {
    stagedRequests = []
  }
  for (const doc of stagedRequests) {
    if (await skipsAsAlreadyImported(params.alreadyImportedRequest, doc)) continue
    try {
      await params.submitRequest(doc)
      imported += 1
    } catch {
      errorItemIds.push(params.requestIdOf(doc))
    }
  }

  let stagedAttestations: readonly TAtt[] = []
  try {
    stagedAttestations = await params.readStagedAttestations()
  } catch {
    stagedAttestations = []
  }
  for (const doc of stagedAttestations) {
    if (await skipsAsAlreadyImported(params.alreadyImportedAttestation, doc)) continue
    try {
      await params.submitAttestation(doc)
      imported += 1
    } catch {
      errorItemIds.push(params.attestationIdOf(doc))
    }
  }

  // UNCONDITIONAL — see the doc comment above. No branch above this line
  // may return early or otherwise skip this call.
  await params.processPending()

  return { syncedAt: new Date().toISOString(), imported, pending: 0, errorItemIds }
}
