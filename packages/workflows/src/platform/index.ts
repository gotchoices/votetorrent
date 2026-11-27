// The `./platform` subpath of @votetorrent/workflows: the type-only seams each app and the CLI
// implement. The file set below is fixed by the phase-67 barrel rule: a plan that needs a new seam edits
// the matching file, never this index. A name exported by two files here is a TS2308 build error, so it
// must be renamed at its source. This subpath carries no runtime value (pinned by test/skeleton.spec.ts).
export * from './storage.js'
export * from './signer.js'
export * from './secret-wrap.js'
export * from './attestation.js'
export * from './vote-record-wrap.js'
