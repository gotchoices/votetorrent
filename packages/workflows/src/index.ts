// Root entry of @votetorrent/workflows: the platform seams plus the two common barrels. The role
// subpaths `./authority` and `./voter` carry the workflow drivers. The barrel set is fixed by the phase-67
// barrel rule: extraction plans edit only their own barrel and never an index file. A name exported by
// two barrels of one subpath is a TS2308 build error, so it must be renamed at its source.
export * from './platform/index.js'
export * from './common/strand.js'
export * from './common/join-node.js'
