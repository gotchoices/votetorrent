// "Make permanent" for media URLs: fingerprintMedia downloads once and records the content id of
// the bytes; verifyMediaFingerprint detects a swapped file. Also covers the ImageRef storage
// forms: toImageRef accepts both the historical bare-string and the `{ url, cid }` object, and
// NetworksEngine.create writes the object only when a cid was taken.

import { expect } from 'chai'
import { Database } from '@quereus/quereus'
import { toImageRef, type NetworkReference } from '@votetorrent/vote-core'
import { prepareDb } from '../src/database/initialize.js'
import {
  fingerprintMedia,
  isFingerprintableUrl,
  MAX_MEDIA_BYTES,
  MediaFingerprintError,
  mediaCid,
  verifyMediaFingerprint,
  type MediaFetch,
  type MediaResponse
} from '../src/media/media-fingerprint.js'
import { createTestNetwork } from './fixtures/test-context.js'

function bytes (text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function respond (body: Uint8Array, init: { status?: number, contentLength?: number } = {}): MediaResponse {
  const status = init.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-length' && init.contentLength !== undefined ? String(init.contentLength) : null) },
    arrayBuffer: async () => body.slice().buffer
  }
}

function fetchServing (body: Uint8Array, init?: { status?: number, contentLength?: number }): { fetch: MediaFetch, calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    fetch: async (url: string) => {
      calls.push(url)
      return respond(body, init)
    }
  }
}

async function failure (promise: Promise<unknown>): Promise<MediaFingerprintError> {
  try {
    await promise
  } catch (err) {
    expect(err).to.be.instanceOf(MediaFingerprintError)
    return err as MediaFingerprintError
  }
  throw new Error('expected a MediaFingerprintError')
}

describe('media fingerprint', () => {
  it('matches the schema\'s own cid() for the same bytes', async () => {
    const db = new Database()
    await prepareDb(db)
    const data = bytes('hello media')
    const row = await db.prepare('select cid(:data) as c').get({ data })
    expect(mediaCid(data)).to.equal(row!.c)
    expect(mediaCid(data)).to.match(/^b[a-z2-7]+$/)
  })

  it('downloads the url once and returns { url, cid }', async () => {
    const data = bytes('png bytes')
    const { fetch, calls } = fetchServing(data)
    const result = await fingerprintMedia('  https://example.org/logo.png ', { fetch })
    expect(calls).to.deep.equal(['https://example.org/logo.png'])
    expect(result).to.deep.equal({ url: 'https://example.org/logo.png', cid: mediaCid(data) })
  })

  it('fetches a capitalized scheme in canonical lowercase but reports the url as entered', async () => {
    const { fetch, calls } = fetchServing(bytes('x'))
    const result = await fingerprintMedia('Http://10.0.2.2:8765/Seal.png', { fetch })
    expect(calls).to.deep.equal(['http://10.0.2.2:8765/Seal.png'])
    expect(result.url).to.equal('Http://10.0.2.2:8765/Seal.png')
  })

  it('refuses non-http(s) urls without fetching', async () => {
    const { fetch, calls } = fetchServing(bytes('x'))
    for (const url of ['file:///etc/passwd', 'data:image/png;base64,AAAA', 'logo.png', '']) {
      expect(isFingerprintableUrl(url)).to.equal(false)
      expect((await failure(fingerprintMedia(url, { fetch }))).reason).to.equal('invalid-url')
    }
    expect(calls).to.have.length(0)
  })

  it('accepts http(s) urls with ports, paths and queries', () => {
    for (const url of ['http://10.0.2.2:8765/logo.png', 'https://cdn.example.org/a/b.png?v=2', 'HTTPS://x.test']) {
      expect(isFingerprintableUrl(url), url).to.equal(true)
    }
    for (const url of ['https://', 'http:///a.png', 'https://user@host/a', 'ftp://x.test/a', 'https://x .test/a']) {
      expect(isFingerprintableUrl(url), url).to.equal(false)
    }
  })

  it('does not depend on the URL class (React Native\'s throws from .protocol)', async () => {
    const realUrl = globalThis.URL
    class ThrowingUrl {
      get protocol (): string { throw new Error('URL.protocol is not implemented') }
      get hostname (): string { throw new Error('URL.hostname is not implemented') }
    }
    ;(globalThis as { URL: unknown }).URL = ThrowingUrl
    try {
      expect(isFingerprintableUrl('http://10.0.2.2:8765/logo.png')).to.equal(true)
      const { fetch } = fetchServing(bytes('x'))
      expect((await fingerprintMedia('http://10.0.2.2:8765/logo.png', { fetch })).cid).to.equal(mediaCid(bytes('x')))
    } finally {
      ;(globalThis as { URL: unknown }).URL = realUrl
    }
  })

  it('reports http, network, empty and too-large failures by reason', async () => {
    expect((await failure(fingerprintMedia('https://x.test/a', fetchServing(bytes('x'), { status: 404 })))).reason).to.equal('http')
    expect((await failure(fingerprintMedia('https://x.test/a', { fetch: async () => { throw new Error('offline') } }))).reason).to.equal('network')
    expect((await failure(fingerprintMedia('https://x.test/a', fetchServing(new Uint8Array(0))))).reason).to.equal('empty')
    // Declared size over the limit is refused before the body is read.
    expect((await failure(fingerprintMedia('https://x.test/a', fetchServing(bytes('x'), { contentLength: MAX_MEDIA_BYTES + 1 })))).reason).to.equal('too-large')
    // Actual size over a (lowered) limit is refused even when no length is declared.
    expect((await failure(fingerprintMedia('https://x.test/a', { ...fetchServing(bytes('12345')), maxBytes: 4 }))).reason).to.equal('too-large')
  })

  it('verifyMediaFingerprint detects a swapped file', async () => {
    const original = bytes('original')
    const ref = await fingerprintMedia('https://x.test/a', fetchServing(original))
    expect(await verifyMediaFingerprint(ref, fetchServing(original))).to.equal('match')
    expect(await verifyMediaFingerprint(ref, fetchServing(bytes('swapped')))).to.equal('mismatch')
    expect(await verifyMediaFingerprint({ url: 'https://x.test/a' }, fetchServing(original))).to.equal('unpinned')
  })
})

describe('toImageRef', () => {
  it('accepts both stored ImageRef forms', () => {
    expect(toImageRef('https://x.test/a.png')).to.deep.equal({ url: 'https://x.test/a.png' })
    expect(toImageRef({ url: 'https://x.test/a.png', cid: 'bafk' })).to.deep.equal({ url: 'https://x.test/a.png', cid: 'bafk' })
    expect(toImageRef({ url: 'https://x.test/a.png' })).to.deep.equal({ url: 'https://x.test/a.png' })
  })

  it('normalizes junk to undefined', () => {
    for (const value of [null, undefined, '', '  ', 42, [], {}, { url: 7 }, { url: '' }]) {
      expect(toImageRef(value)).to.equal(undefined)
    }
  })
})

describe('NetworksEngine.create image refs', () => {
  async function storedImageRefs (net: Awaited<ReturnType<typeof createTestNetwork>>): Promise<{ network: unknown, authority: unknown }> {
    const n = await net.ctx.db.prepare('select ImageRef from Network').get({})
    const a = await net.ctx.db.prepare('select ImageRef from Authority where Id = (select PrimaryAuthorityId from Network)').get({})
    return { network: n?.ImageRef, authority: a?.ImageRef }
  }

  it('keeps the historical bare-string form when no cid was taken', async () => {
    const net = await createTestNetwork({ network: { imageUrl: 'https://x.test/net.png' } })
    const { network } = await storedImageRefs(net)
    expect(network).to.equal(JSON.stringify('https://x.test/net.png'))
    const details = await net.networkEngine.getDetails()
    // The reader resolves the bare-string form — this read used to come back with no url.
    expect(details.network.imageRef).to.deep.equal({ url: 'https://x.test/net.png' })
  })

  it('stores { url, cid } for pinned network and authority images and reads them back', async () => {
    const net = await createTestNetwork({
      network: {
        imageUrl: 'https://x.test/net.png',
        imageCid: 'bafknet',
        primaryAuthority: { name: 'Primary Authority', domainName: 'authority.example.com', imageUrl: 'https://x.test/auth.png', imageCid: 'bafkauth' }
      }
    })
    const stored = await storedImageRefs(net)
    expect(JSON.parse(String(stored.network))).to.deep.equal({ url: 'https://x.test/net.png', cid: 'bafknet' })
    expect(JSON.parse(String(stored.authority))).to.deep.equal({ url: 'https://x.test/auth.png', cid: 'bafkauth' })

    const details = await net.networkEngine.getDetails()
    expect(details.network.imageRef).to.deep.equal({ url: 'https://x.test/net.png', cid: 'bafknet' })
    const ref: NetworkReference = net.ref
    expect(ref.imageUrl).to.equal('https://x.test/net.png')
  })
})
