// Secret registry and redaction (red stub: every function body throws until the implementation lands).

export const PEER_RE = /12D3Koo[1-9A-HJ-NP-Za-km-z]{30,}/g
export const LAN_RE = /\b(?:10\.\d+|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+\b/g

export interface RedactOptions {
  paths?: ReadonlyArray<readonly [string, string]>
  home?: string
}

export function last8(_id: string): string {
  throw new Error('unimplemented')
}

export class SecretRegistry {
  add(_value: unknown, _opts?: { windows?: boolean }): string {
    throw new Error('unimplemented')
  }

  get size(): number {
    throw new Error('unimplemented')
  }

  entries(): IterableIterator<[string, boolean]> {
    throw new Error('unimplemented')
  }

  hasWindow(_s: string): boolean {
    throw new Error('unimplemented')
  }

  get windowCount(): number {
    throw new Error('unimplemented')
  }

  redactor(_opts?: RedactOptions): (text: string) => string {
    throw new Error('unimplemented')
  }
}

export function redact(_text: unknown, _registry?: SecretRegistry, _opts?: RedactOptions): string {
  throw new Error('unimplemented')
}
