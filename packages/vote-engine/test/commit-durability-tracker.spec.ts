/**
 * commit-durability-tracker.spec.ts -- todo 2026-09-11-optimystic-commit-success-hides-unresolvable-cohort.
 *
 * The tracker turns cadre-core's `strand:commit-durability` / `strand:commit-held` events into an
 * app-wide "not shared yet" count and a per-action state. Driven here by a plain EventEmitter that
 * emits the same payload shape; the type assertion below pins that shape to cadre-core's own
 * exported StrandCommitDurability / StrandCommitHeld, so a cadre-core rename fails to compile.
 */
import { EventEmitter } from 'node:events'
import { expect } from 'chai'
import type { CadreNode, StrandCommitDurability, StrandCommitHeld } from '@serfab/cadre-core'
import { CommitDurabilityTracker } from '../src/durability/commit-durability-tracker.js'
import type { CommitDurabilityReport, CommitEventSource, CommitHeldReport } from '../src/durability/commit-durability-tracker.js'

// Compile-time: cadre-core's payloads are assignable to what the tracker reads.
const _durabilityShape = (e: StrandCommitDurability): CommitDurabilityReport => e
const _heldShape = (e: StrandCommitHeld): CommitHeldReport => e
void _durabilityShape
// Compile-time: a real CadreNode is an event source the tracker can attach to.
const _nodeIsSource = (n: CadreNode): CommitEventSource => n
void _nodeIsSource
void _heldShape

function report (tx: string, heldElsewhere: boolean, followed = true, strandId = 'strand-a'): CommitDurabilityReport {
  return { strandId, transactionId: tx, heldElsewhere, followed }
}

function setup () {
  const node = new EventEmitter()
  const tracker = new CommitDurabilityTracker()
  tracker.attach(node)
  let changes = 0
  tracker.subscribe(() => { changes++ })
  return { node, tracker, changes: () => changes }
}

describe('CommitDurabilityTracker', () => {
  it('counts a commit no other member holds, and stops counting it when it is held', () => {
    const { node, tracker } = setup()
    node.emit('strand:commit-durability', report('t1', false))
    node.emit('strand:commit-durability', report('t2', true))
    expect(tracker.unsharedCount).to.equal(1)
    node.emit('strand:commit-held', { strandId: 'strand-a', transactionId: 't1' })
    expect(tracker.unsharedCount).to.equal(0)
  })

  it('keys commits by strand: the same tx id on another strand is a different commit', () => {
    const { node, tracker } = setup()
    node.emit('strand:commit-durability', report('t1', false, true, 'strand-a'))
    node.emit('strand:commit-durability', report('t1', false, true, 'strand-b'))
    node.emit('strand:commit-held', { strandId: 'strand-b', transactionId: 't1' })
    expect(tracker.unsharedCount).to.equal(1)
  })

  it('an action whose commit stayed on this phone reads waiting, then shared once it is held', async () => {
    const { node, tracker } = setup()
    const result = await tracker.track('registration:r1', async () => {
      node.emit('strand:commit-durability', report('t1', false))
      return 'done'
    })
    expect(result).to.equal('done')
    expect(tracker.actionState('registration:r1')).to.equal('waiting')
    node.emit('strand:commit-held', { strandId: 'strand-a', transactionId: 't1' })
    expect(tracker.actionState('registration:r1')).to.equal('shared')
  })

  it('an action every commit of which another member already holds reads shared', async () => {
    const { node, tracker } = setup()
    await tracker.track('decision:d1', async () => {
      node.emit('strand:commit-durability', report('t1', true))
      node.emit('strand:commit-durability', report('t2', true))
    })
    expect(tracker.actionState('decision:d1')).to.equal('shared')
  })

  it('one local commit among shared ones makes the whole action waiting (never a false shared)', async () => {
    const { node, tracker } = setup()
    await tracker.track('decision:d1', async () => {
      node.emit('strand:commit-durability', report('t1', true))
      node.emit('strand:commit-durability', report('t2', false))
    })
    expect(tracker.actionState('decision:d1')).to.equal('waiting')
  })

  it('an action that made no commit, or was never tracked, is unknown', async () => {
    const { tracker } = setup()
    await tracker.track('noop', async () => undefined)
    expect(tracker.actionState('noop')).to.equal('unknown')
    expect(tracker.actionState('never')).to.equal('unknown')
  })

  it('commits reported outside every window are not attributed to an action', async () => {
    const { node, tracker } = setup()
    node.emit('strand:commit-durability', report('before', false))
    await tracker.track('a', async () => {
      node.emit('strand:commit-durability', report('inside', true))
    })
    node.emit('strand:commit-durability', report('after', false))
    expect(tracker.actionState('a')).to.equal('shared')
    expect(tracker.unsharedCount).to.equal(2)
  })

  it('overlapping actions both see a commit made while both run (conservative)', async () => {
    const { node, tracker } = setup()
    let releaseA!: () => void
    const a = tracker.track('a', () => new Promise<void>(resolve => { releaseA = resolve }))
    await tracker.track('b', async () => {
      node.emit('strand:commit-durability', report('t1', false))
    })
    releaseA()
    await a
    expect(tracker.actionState('a')).to.equal('waiting')
    expect(tracker.actionState('b')).to.equal('waiting')
  })

  it('a throwing action still records its commits and rethrows', async () => {
    const { node, tracker } = setup()
    let caught: unknown
    try {
      await tracker.track('a', async () => {
        node.emit('strand:commit-durability', report('t1', false))
        throw new Error('later step failed')
      })
    } catch (err) { caught = err }
    expect((caught as Error).message).to.equal('later step failed')
    expect(tracker.actionState('a')).to.equal('waiting')
  })

  it('an unfollowed commit stays counted: nothing will report it reaching anyone', () => {
    const { node, tracker } = setup()
    node.emit('strand:commit-durability', report('t1', false, false))
    expect(tracker.unsharedCount).to.equal(1)
    expect(tracker.unfollowedCount).to.equal(1)
  })

  it('notifies subscribers on every change, and a throwing subscriber does not stop the others', () => {
    const { node, tracker, changes } = setup()
    tracker.subscribe(() => { throw new Error('bad listener') })
    node.emit('strand:commit-durability', report('t1', false))
    node.emit('strand:commit-held', { strandId: 'strand-a', transactionId: 't1' })
    expect(changes()).to.equal(2)
  })

  it('detach stops listening and keeps what was recorded; attach to a new node moves it', () => {
    const { node, tracker } = setup()
    node.emit('strand:commit-durability', report('t1', false))
    tracker.detach()
    expect(node.listenerCount('strand:commit-durability')).to.equal(0)
    node.emit('strand:commit-durability', report('t2', false))
    expect(tracker.unsharedCount).to.equal(1)
    const next = new EventEmitter()
    tracker.attach(next)
    next.emit('strand:commit-durability', report('t3', false))
    expect(tracker.unsharedCount).to.equal(2)
    expect(tracker.attached).to.equal(true)
  })

  it('caps memory: the oldest unshared commits are forgotten past maxTracked', () => {
    const node = new EventEmitter()
    const tracker = new CommitDurabilityTracker({ maxTracked: 3 })
    tracker.attach(node)
    for (const tx of ['t1', 't2', 't3', 't4', 't5']) node.emit('strand:commit-durability', report(tx, false))
    expect(tracker.unsharedCount).to.equal(3)
  })

  it('waitingActionCount counts only waiting actions under a prefix', async () => {
    const { node, tracker } = setup()
    await tracker.track('decision:a', async () => { node.emit('strand:commit-durability', report('t1', false)) })
    await tracker.track('decision:b', async () => { node.emit('strand:commit-durability', report('t2', true)) })
    await tracker.track('registration:c', async () => { node.emit('strand:commit-durability', report('t3', false)) })
    expect(tracker.waitingActionCount('decision:')).to.equal(1)
    node.emit('strand:commit-held', { strandId: 'strand-a', transactionId: 't1' })
    expect(tracker.waitingActionCount('decision:')).to.equal(0)
    expect(tracker.waitingActionCount('registration:')).to.equal(1)
  })

  it('ignores malformed payloads', () => {
    const { node, tracker } = setup()
    node.emit('strand:commit-durability', null)
    node.emit('strand:commit-durability', { strandId: 1, transactionId: 't' })
    node.emit('strand:commit-held', undefined)
    expect(tracker.unsharedCount).to.equal(0)
  })
})
