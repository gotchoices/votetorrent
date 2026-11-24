export interface RedactableStream {
  write(chunk: string | Uint8Array, encoding?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void): boolean
}
export function installOutputRedaction(_opts: { redactor: (s: string) => string, streams?: RedactableStream[] }): { flush(): void, uninstall(): void } {
  throw new Error('unimplemented')
}
