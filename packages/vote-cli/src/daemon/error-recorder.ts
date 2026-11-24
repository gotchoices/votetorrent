export interface ErrorRecorder {
  record(where: string, err: unknown): void
  readonly count: number
  installProcessHandlers(proc?: NodeJS.EventEmitter & { stdout: { write(s: string): unknown } }): void
}
export function createErrorRecorder(_opts: { file: string, redactor: (s: string) => string, maxRecords?: number, now?: () => number }): ErrorRecorder {
  throw new Error('unimplemented')
}
