// Secret scan over a run dir (red stub).

import type { SecretRegistry } from './redact.js'

export function scanSecrets(_root: string, _registry: SecretRegistry): { whole: number, windows: number, files: number } {
  throw new Error('unimplemented')
}
