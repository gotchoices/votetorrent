// Line redaction of the daemon's own stdout and stderr. Each stream's `write` is replaced: chunks are
// buffered up to the last newline, every complete line passes through the redactor (which keeps the
// `<ISO> <namespace> ` debug prefix intact, since it only replaces secrets, hex64 runs, peer ids, LAN
// addresses and paths), and the remainder is held for the next chunk. A pending remainder over 64 KiB
// is redacted and written as is (a line that long is a dump, not a log line). `uninstall` flushes
// what is held and restores the original writers. Callbacks and encodings are honoured.

export interface RedactableStream {
  write(chunk: string | Uint8Array, encoding?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void): boolean
}

export interface OutputRedaction {
  /** Redacts and writes whatever is held, without uninstalling. */
  flush(): void
  /** Flushes, then restores every stream's original `write`. Idempotent. */
  uninstall(): void
}

const MAX_PENDING_CHARS = 64 * 1024

export function installOutputRedaction(opts: { redactor: (s: string) => string, streams?: RedactableStream[] }): OutputRedaction {
  const { redactor } = opts
  const streams = opts.streams ?? [process.stdout, process.stderr]
  const redactLines = (text: string): string => text.split('\n').map((l) => (l.length === 0 ? l : redactor(l))).join('\n')
  const installed = streams.map((stream) => {
    const original = stream.write.bind(stream)
    let pending = ''
    const flush = (): void => {
      if (pending.length === 0) return
      const out = redactor(pending)
      pending = ''
      original(out)
    }
    const write: RedactableStream['write'] = (chunk, encoding, cb) => {
      const done = typeof encoding === 'function' ? encoding : cb
      const enc = typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8'
      pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(enc)
      let out = ''
      const nl = pending.lastIndexOf('\n')
      if (nl >= 0) {
        out = redactLines(pending.slice(0, nl + 1))
        pending = pending.slice(nl + 1)
      }
      if (pending.length > MAX_PENDING_CHARS) {
        out += redactor(pending)
        pending = ''
      }
      if (out.length > 0) return done === undefined ? original(out) : original(out, done)
      done?.()
      return true
    }
    stream.write = write
    return { stream, original, flush, write }
  })
  let removed = false
  return {
    flush() {
      for (const i of installed) i.flush()
    },
    uninstall() {
      if (removed) return
      removed = true
      for (const i of installed) {
        i.flush()
        if (i.stream.write === i.write) i.stream.write = i.original
      }
    }
  }
}
