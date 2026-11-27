import { expect } from 'chai'
import { reopenJoinedNetworks, type ReopenContext } from '../src/daemon/reopen-networks.js'

const A = 'aa'.repeat(16)
const B = 'bb'.repeat(16)

function ctxOf (input: {
  recents: unknown
  user?: unknown
  open?: (hash: string) => Promise<unknown>
}): { ctx: ReopenContext, opened: string[], records: string[] } {
  const opened: string[] = []
  const records: string[] = []
  const ctx = {
    user: input.user === undefined ? { id: 'user-1' } : input.user,
    localStorage: {
      getItem: async () => {
        if (input.recents instanceof Error) throw input.recents
        return input.recents
      }
    },
    openNetwork: async (hash: string) => {
      opened.push(hash)
      return input.open?.(hash)
    },
    record: (where: string) => { records.push(where) }
  } as unknown as ReopenContext
  return { ctx, opened, records }
}

describe('daemon: reopen joined networks', () => {
  it('opens every joined network once and reports counts', async () => {
    const r = ctxOf({ recents: [{ hash: A }, { hash: B }, { hash: A }, { hash: 7 }] })
    expect(await reopenJoinedNetworks(r.ctx)).to.deep.equal({ known: 2, opened: 2, failed: 0, pending: 0 })
    expect(r.opened).to.deep.equal([A, B])
    expect(r.records).to.deep.equal([])
  })

  it('opens nothing for a peer with no joined network or no identity', async () => {
    const none = ctxOf({ recents: null })
    expect(await reopenJoinedNetworks(none.ctx)).to.deep.equal({ known: 0, opened: 0, failed: 0, pending: 0 })
    const anonymous = ctxOf({ recents: [{ hash: A }], user: null })
    expect(await reopenJoinedNetworks(anonymous.ctx)).to.deep.equal({ known: 1, opened: 0, failed: 0, pending: 0 })
    expect([...none.opened, ...anonymous.opened]).to.deep.equal([])
  })

  it('records a failed open or an unreadable store and still returns, so the boot goes on', async () => {
    const r = ctxOf({ recents: [{ hash: A }, { hash: B }], open: async (h) => { if (h === A) throw new Error('offline') } })
    expect(await reopenJoinedNetworks(r.ctx)).to.deep.equal({ known: 2, opened: 1, failed: 1, pending: 0 })
    expect(r.records).to.deep.equal(['boot.reopen-network'])
    const broken = ctxOf({ recents: new Error('unreadable') })
    expect(await reopenJoinedNetworks(broken.ctx)).to.deep.equal({ known: 0, opened: 0, failed: 0, pending: 0 })
    expect(broken.records).to.deep.equal(['boot.reopen-network'])
  })

  it('stops waiting at the bound for an open that never settles', async () => {
    const r = ctxOf({ recents: [{ hash: A }], open: () => new Promise(() => {}) })
    expect(await reopenJoinedNetworks(r.ctx, 20)).to.deep.equal({ known: 1, opened: 0, failed: 0, pending: 1 })
  })
})
