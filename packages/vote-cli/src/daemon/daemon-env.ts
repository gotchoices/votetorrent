export const DEBUG_ALLOWED_PREFIXES: readonly string[] = Object.freeze(['optimystic:', 'sereus:'])
export const DEBUG_REDACTED_NAMESPACES: readonly string[] = Object.freeze([])
export function filterDebugNamespaces(_raw: string | undefined): { value: string | undefined, kept: number, dropped: number } {
  throw new Error('unimplemented')
}
export function applyDaemonEnv(_env: NodeJS.ProcessEnv = process.env): { debugKept: number, debugDropped: number, nodeOptionsSet: boolean } {
  throw new Error('unimplemented')
}
