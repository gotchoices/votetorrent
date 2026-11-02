/**
 * strand-change-hub.spec.ts — screens subscribe to strand table changes through one hub. Proves binding
 * before and after attach, the re-bind (and one catch-up run) on a new source, detach keeping
 * subscriptions, the backstop default and opt-out, unsubscribe, and that a refused table or a throwing
 * listener is reported, never thrown.
 */

import { expect } from 'chai'
import { StrandChangeHub, STRAND_CHANGE_BACKSTOP_MS, type StrandChangeSource } from '../src/reactivity/strand-change-hub.js'

interface FakeWatch { tables: readonly string[], onChange: () => Promise<void>, options: { label: string, coalesceMs?: number, backstopMs?: number }, disposed: boolean, triggers: number[] }

function fakeSource (refuse: string[] = []): StrandChangeSource & { watches: FakeWatch[], fire: (table: string) => Promise<void> } {
  const watches: FakeWatch[] = []
  return {
    watches,
    watchTables (tables, onChange, options) {
      for (const t of tables) if (refuse.includes(t)) throw new Error(`no such table ${t}`)
      const w: FakeWatch = { tables, onChange, options, disposed: false, triggers: [] }
      watches.push(w)
      return {
        trigger: (delayMs) => { w.triggers.push(delayMs ?? 0); void w.onChange() },
        dispose: () => { w.disposed = true }
      }
    },
    async fire (table) {
      for (const w of watches) if (!w.disposed && w.tables.includes(table)) await w.onChange()
    }
  }
}

describe('StrandChangeHub (strand table changes for screens)', () => {
  it('a subscription made after attach is bound and hears its tables only', async () => {
    const hub = new StrandChangeHub()
    const src = fakeSource()
    hub.attach('net-1', src)
    let runs = 0
    hub.subscribe(['App.Election'], () => { runs++ }, { label: 'home' })
    await src.fire('App.Ballot')
    expect(runs).to.equal(0)
    await src.fire('App.Election')
    expect(runs).to.equal(1)
    expect(src.watches[0]!.options.backstopMs).to.equal(STRAND_CHANGE_BACKSTOP_MS)
  })

  it('a subscription made before any strand is bound on attach and runs once to catch up', async () => {
    const hub = new StrandChangeHub()
    let runs = 0
    hub.subscribe(['App.Election'], () => { runs++ }, { label: 'home' })
    expect(runs).to.equal(0)
    const src = fakeSource()
    hub.attach('net-1', src)
    expect(src.watches).to.have.length(1)
    expect(runs).to.equal(1)
    expect(hub.attachedStrandId).to.equal('net-1')
  })

  it('re-attaching the same source is a no-op; a new source re-binds, disposes the old watch and catches up', async () => {
    const hub = new StrandChangeHub()
    const a = fakeSource()
    hub.attach('net-1', a)
    let runs = 0
    hub.subscribe(['App.Election'], () => { runs++ }, { label: 'home' })
    hub.attach('net-1', a)
    expect(a.watches).to.have.length(1)
    expect(runs).to.equal(0)
    const b = fakeSource()
    hub.attach('net-2', b)
    expect(a.watches[0]!.disposed).to.equal(true)
    expect(b.watches).to.have.length(1)
    expect(runs).to.equal(1)
    await a.fire('App.Election')
    expect(runs, 'the old source no longer reaches the listener').to.equal(1)
  })

  it('detach keeps subscriptions for the next attach; a detach for another strand is ignored', () => {
    const hub = new StrandChangeHub()
    const a = fakeSource()
    hub.attach('net-1', a)
    hub.subscribe(['App.Election'], () => undefined, { label: 'home' })
    hub.detach('net-other')
    expect(a.watches[0]!.disposed).to.equal(false)
    hub.detach('net-1')
    expect(a.watches[0]!.disposed).to.equal(true)
    expect(hub.size).to.equal(1)
    const b = fakeSource()
    hub.attach('net-1', b)
    expect(b.watches).to.have.length(1)
  })

  it('unsubscribe disposes the watch; a second call is harmless', () => {
    const hub = new StrandChangeHub()
    const src = fakeSource()
    hub.attach('net-1', src)
    const off = hub.subscribe(['App.Election'], () => undefined, { label: 'home', backstopMs: 0, coalesceMs: 10 })
    expect(src.watches[0]!.options).to.deep.equal({ label: 'home', coalesceMs: 10 })
    off()
    off()
    expect(src.watches[0]!.disposed).to.equal(true)
    expect(hub.size).to.equal(0)
  })

  it('a refused table and a throwing listener are reported, never thrown', async () => {
    const errors: string[] = []
    const hub = new StrandChangeHub((label, err) => errors.push(`${label}: ${String(err)}`))
    const src = fakeSource(['App.Nope'])
    hub.attach('net-1', src)
    expect(() => hub.subscribe(['App.Nope'], () => undefined, { label: 'bad' })).to.not.throw()
    hub.subscribe(['App.Election'], () => { throw new Error('boom') }, { label: 'thrower' })
    await src.fire('App.Election')
    expect(errors).to.have.length(2)
    expect(errors[0]).to.contain('bad').and.contain('no such table')
    expect(errors[1]).to.contain('thrower').and.contain('boom')
  })
})
