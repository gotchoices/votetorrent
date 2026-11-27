/**
 * cadre-node-boot.ts — the ONE CadreNode boot sequence of both apps' CadreNodeProviders and the vt CLI's
 * role daemons. The option set the node is built from comes from `buildCadreNodeOptions`
 * (`./cadre-node-options.js`): the caller's `createNode` closure calls it on every construction, so the
 * edge-reader refusal reuse, the stores and `strandDatabaseSetup` ride in the options, not here.
 *
 * `bootCadreNode` runs five steps in a fixed order:
 * - S1 validates its input (party id, createNode, destroyScope, controlStorageScope) before anything runs.
 * - S2 creates the node and awaits `start()`.
 * - S3 recovers ONCE from a start rejection that `isUnrestorableControlSchemaError` recognises: it warns
 *   with the closed line, stops the failed node, destroys ONLY the control scope of this party, creates a
 *   second node and awaits its start with NO try around it. A second failure propagates; there is no loop
 *   and no second recovery. Any other start error is rethrown as the same object, and nothing is wiped
 *   (a `newer-release` refusal never matches the predicate).
 * - S4 (when `ownerTrust` is given) re-anchors the owner key exactly once, on the FINAL node, then reads the
 *   owner-trust classification on a persistent store and maps it to the provider's state.
 * - S5 (when `rendezvous` is given and `shouldHost()` is true) starts the best-effort pool rendezvous host
 *   WITHOUT awaiting it, so the boot is never held by the rendezvous; a host failure resolves to null and
 *   warns with the closed prefix and the message.
 *
 * A rejected boot does NOT stop the node. The caller's `createNode` closure always holds the last node it
 * made (both providers keep it in `localNode`), and the caller's existing catch stops it. Every cadre-core
 * value (the node constructor, `controlStorageScope`, the owner-trust and rendezvous functions) is passed
 * in by the caller: this module imports nothing but its siblings.
 */
import { CadreNodeOptionsError } from './cadre-node-options.js'
import { isUnrestorableControlSchemaError } from './control-schema-recovery.js'

export interface BootableCadreNode {
  start(): Promise<unknown>
  stop(): Promise<unknown>
}

export interface CadreNodeBootInput<N extends BootableCadreNode> {
  partyId: string
  /** The caller's closure: it must call `buildCadreNodeOptions` on each call and keep the last node it made. */
  createNode(): N
  /** Destroys one storage scope (the caller's scoped storage provider). Called only with the control scope. */
  destroyScope(scopeId: string): Promise<void>
  /** cadre-core's `controlStorageScope`, passed in (the control scope is `control-<hex(partyId)>`). */
  controlStorageScope(partyId: string): string
  /** For example `[CadreNodeProvider]`. */
  logTag: string
  warn(...args: unknown[]): void
  ownerTrust?: {
    storeKind: 'persistent' | 'memory'
    reanchorOwnKey(node: N): Promise<string>
    readOwnerTrustClassification(node: N, kind: 'persistent'): Promise<'ok' | 'needs-reinvite' | 'unreadable'>
  }
  rendezvous?: {
    host(node: N): Promise<() => Promise<void>>
    shouldHost(): boolean
  }
}

export interface CadreNodeBoot<N> {
  node: N
  recreated: boolean
  recreatedScope: string | null
  reanchor: string | null
  ownerTrust: 'ok' | 'needs-reinvite' | 'memory-only' | null
  rendezvous: Promise<(() => Promise<void>) | null> | null
}

export async function bootCadreNode<N extends BootableCadreNode>(input: CadreNodeBootInput<N>): Promise<CadreNodeBoot<N>> {
  // S1
  const { partyId, logTag, warn, ownerTrust, rendezvous } = input
  if (typeof partyId !== 'string' || partyId.trim() === '') throw new CadreNodeOptionsError('party-id-missing')
  if (typeof input.createNode !== 'function') throw new CadreNodeOptionsError('create-node-missing')
  if (typeof input.destroyScope !== 'function') throw new CadreNodeOptionsError('destroy-scope-missing')
  if (typeof input.controlStorageScope !== 'function') throw new CadreNodeOptionsError('control-scope-missing')

  // S2
  let node = input.createNode()
  let recreated = false
  let recreatedScope: string | null = null
  try {
    await node.start()
  } catch (startError) {
    // S3: a control store an older cadre-core wrote can be neither migrated nor restored, so every launch
    // fails. cadre-core's policy is to recreate it. Recreate ONLY the control scope (the peer key and every
    // network's strand store stay) and start once more.
    if (!isUnrestorableControlSchemaError(startError)) throw startError
    const scope = input.controlStorageScope(partyId)
    warn(`${logTag} control store '${scope}' was written by an older cadre-core and cannot be migrated; recreating it`)
    await node.stop().catch(() => undefined)
    await input.destroyScope(scope)
    node = input.createNode()
    await node.start()
    recreated = true
    recreatedScope = scope
  }

  // S4
  let reanchor: string | null = null
  let ownerTrustState: CadreNodeBoot<N>['ownerTrust'] = null
  if (ownerTrust) {
    // Anchors this node's own key when its OwnerKey row is live. It never pins a foreign key, and the shared
    // implementation is bounded and never rejecting, so it cannot stop the boot.
    reanchor = await ownerTrust.reanchorOwnKey(node)
    // Classify AFTER the re-anchor. An unreadable read reports 'ok' (the implementation logs the token).
    const classification = ownerTrust.storeKind === 'persistent' ? await ownerTrust.readOwnerTrustClassification(node, 'persistent') : 'ok'
    ownerTrustState = ownerTrust.storeKind === 'memory' ? 'memory-only' : classification === 'needs-reinvite' ? 'needs-reinvite' : 'ok'
  }

  // S5
  let rendezvousPromise: CadreNodeBoot<N>['rendezvous'] = null
  if (rendezvous && rendezvous.shouldHost()) {
    // This node is the rendezvous its voters pool their votes through. Best effort: a voter that cannot reach
    // it keeps its vote saved, never lost. Not awaited.
    rendezvousPromise = rendezvous.host(node).then(
      (detach) => detach,
      (e: unknown) => {
        warn(`${logTag} pool rendezvous not hosted:`, e instanceof Error ? e.message : String(e))
        return null
      },
    )
  }

  return { node, recreated, recreatedScope, reanchor, ownerTrust: ownerTrustState, rendezvous: rendezvousPromise }
}
