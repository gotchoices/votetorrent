// test/harness/two-node-strand.ts (reached through the vote-engine test fixtures) reads mocha's `describe`
// at module load; this runner and its self-test run outside mocha. Plain ESM JavaScript: package.json in this
// directory pins "type": "module" (64-12 and 64-13 use .js, 64-11 uses .ts).
const noop = () => {}
noop.skip = () => {}
if (globalThis.describe === undefined) globalThis.describe = noop
export {}
