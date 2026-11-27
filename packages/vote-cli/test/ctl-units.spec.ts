import { expect } from 'chai'
import { MAX_ERROR_MESSAGE_CHARS, ctlErrorView } from '../src/ctl/error-view.js'
import { VerbRegistryError, defineVerbRegistry } from '../src/ctl/verb-registry.js'
import { SecretRegistry } from '../src/secrecy/redact.js'

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (e) {
    expect(e).to.be.instanceOf(VerbRegistryError)
    expect((e as Error).name).to.equal('VerbRegistryError')
    return (e as VerbRegistryError).code
  }
  return undefined
}

const noop = async (): Promise<Record<string, unknown>> => ({})

describe('ctl units: error view and verb registry', () => {
  it('error view keeps name, code, message and chain, never the stack', () => {
    const inner = Object.assign(new Error('inner failure'), { name: 'InnerError' })
    const err = Object.assign(new Error('outer failure', { cause: inner }), { name: 'OuterError', code: 'outer-code' })
    const view = ctlErrorView(err)
    expect(view.name).to.equal('OuterError')
    expect(view.code).to.equal('outer-code')
    expect(view.message).to.equal('outer failure')
    expect(view.chain).to.deep.equal(['OuterError', 'InnerError'])
    for (const k of Object.keys(view)) expect(['name', 'code', 'message', 'chain']).to.include(k)
    expect('stack' in view).to.equal(false)
    expect(JSON.stringify(view)).to.not.include('stack')
  })

  it('error view redacts before it truncates to 200 characters', () => {
    const reg = new SecretRegistry()
    const secret = 'unit-secret-' + 'q'.repeat(28)
    expect(secret.length).to.equal(40)
    reg.add(secret)
    const message = 'm'.repeat(190) + secret + 'm'.repeat(70)
    expect(message.length).to.equal(300)
    const view = ctlErrorView(new Error(message), reg.redactor())
    expect(view.message.length).to.be.at.most(MAX_ERROR_MESSAGE_CHARS)
    expect(view.message).to.not.include(secret)
    expect(view.message).to.not.include(secret.slice(0, 10))
    expect(view.message).to.include('<secret>')
  })

  it('error view replaces an unsafe name or code with a safe default', () => {
    const err = Object.assign(new Error('x\ty\u0000z'), { name: 'bad name\n', code: 'has space' })
    const view = ctlErrorView(err)
    expect(view.name).to.equal('Error')
    expect('code' in view).to.equal(false)
    expect(view.message).to.equal('x y z')
    const numeric = Object.assign(new Error('n'), { code: 42 })
    expect('code' in ctlErrorView(numeric)).to.equal(false)
  })

  it('error view handles a thrown string and an unprintable value', () => {
    const reg = new SecretRegistry()
    const secret = 'unit-thrown-' + 's'.repeat(12)
    reg.add(secret)
    const fromString = ctlErrorView(`failed with ${secret}`, reg.redactor())
    expect(fromString.name).to.equal('Error')
    expect(fromString.message).to.equal('failed with <secret>')
    expect(fromString.message).to.not.include(secret)
    const unprintable = { toString: () => { throw new Error('no string for you') } }
    const view = ctlErrorView(unprintable)
    expect(view.name).to.equal('Error')
    expect(view.message).to.equal('unprintable')
    expect(ctlErrorView(Object.create(null)).message).to.equal('unprintable')
  })

  it('error view chain stops at depth 6', () => {
    let err: Error = Object.assign(new Error('deep 0'), { name: 'Deep0' })
    for (let i = 1; i < 8; i++) err = Object.assign(new Error(`deep ${i}`, { cause: err }), { name: `Deep${i}` })
    const view = ctlErrorView(err)
    expect(view.chain.length).to.equal(6)
    expect(view.chain[0]).to.equal('Deep7')
    expect(view.chain[5]).to.equal('Deep2')
  })

  it('registry refuses a verb name outside [a-z0-9-]+', () => {
    for (const bad of ['Bad_Name', 'a/b', '..', '', 'a'.repeat(65), 'with space', 'tab\t']) {
      expect(codeOf(() => defineVerbRegistry({ [bad]: noop })), JSON.stringify(bad)).to.equal('bad-verb-name')
    }
    expect(codeOf(() => defineVerbRegistry({ ok: noop, ['a'.repeat(64)]: noop }))).to.equal(undefined)
  })

  it('registry refuses the reserved built-in name verbs', () => {
    expect(codeOf(() => defineVerbRegistry({ verbs: noop }))).to.equal('reserved-verb-name')
    expect(codeOf(() => defineVerbRegistry({ echo: noop, verbs: noop }))).to.equal('reserved-verb-name')
    expect(codeOf(() => defineVerbRegistry({ echo: 'not a function' as unknown as typeof noop }))).to.equal('bad-handler')
  })

  it('registry is immutable and has no prototype lookups', () => {
    const registry = defineVerbRegistry({ zeta: noop, alpha: noop, 'mid-dle': noop })
    expect(Object.isFrozen(registry)).to.equal(true)
    expect('set' in registry).to.equal(false)
    expect(Object.keys(registry).sort()).to.deep.equal(['get', 'names'])
    expect(registry.get('constructor')).to.equal(undefined)
    expect(registry.get('toString')).to.equal(undefined)
    expect(registry.get('__proto__')).to.equal(undefined)
    expect(registry.get('hasOwnProperty')).to.equal(undefined)
    expect(registry.get('alpha')).to.equal(noop)
    const first = registry.names()
    expect(first).to.deep.equal(['alpha', 'mid-dle', 'zeta'])
    first.push('intruder')
    first.length = 0
    expect(registry.names()).to.deep.equal(['alpha', 'mid-dle', 'zeta'])
  })
})
