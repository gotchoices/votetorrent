// Test-side leak check for the approval token and file vault specs: fails when `text` holds any
// encoding of a secret (hex, base64, base64url, or the raw latin1 bytes), whole or as any 16-char
// window (the lean rig's scanSecrets rule). The failure message names the form and offset only,
// never the matched value. Distinct from src/secrecy (the runtime redaction port).

const WINDOW = 16

interface Form {
  readonly kind: string
  readonly value: string
}

function formsOf(secret: Uint8Array): Form[] {
  const buf = Buffer.from(secret)
  return [
    { kind: 'hex', value: buf.toString('hex') },
    { kind: 'base64', value: buf.toString('base64') },
    { kind: 'base64url', value: buf.toString('base64url') },
    { kind: 'latin1', value: buf.toString('latin1') }
  ]
}

/** Returns a description of the first leak found in `text`, or undefined. Never includes the value. */
export function findLeak(text: string, secrets: readonly Uint8Array[]): string | undefined {
  for (let s = 0; s < secrets.length; s++) {
    const secret = secrets[s]
    if (secret === undefined) continue
    for (const form of formsOf(secret)) {
      if (form.value.length === 0) continue
      if (text.includes(form.value)) return `secret #${s} leaked whole as ${form.kind}`
      if (form.value.length < WINDOW) continue
      for (let i = 0; i + WINDOW <= form.value.length; i++) {
        if (text.includes(form.value.slice(i, i + WINDOW))) {
          return `secret #${s} leaked a ${WINDOW}-char ${form.kind} window at offset ${i}`
        }
      }
    }
  }
  return undefined
}

/** Throws when `text` contains any secret in any form, whole or windowed. */
export function assertNoLeak(text: string, secrets: readonly Uint8Array[]): void {
  const leak = findLeak(text, secrets)
  if (leak !== undefined) throw new Error(`leak check failed: ${leak}`)
}
