/**
 * Per-database serializer for invite writes.
 *
 * One Quereus Database cannot run two BEGINs at once, so every invite write that opens a transaction
 * goes through `withInviteWriteSerial`: calls on the same Database run strictly one after another, in
 * call order, and a rejection releases the next call. Calls on different Databases never wait on each
 * other. Keyed by the Database object itself (a WeakMap, so nothing is retained after the db is dropped).
 */
const tails = new WeakMap<object, Promise<unknown>>()

export function withInviteWriteSerial<T> (db: object, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(db) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  // The tail must never reject (the next caller chains on it) and must settle only when fn has.
  const tail = run.then(() => undefined, () => undefined)
  tails.set(db, tail)
  return run
}
