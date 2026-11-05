// s63-hooks.mjs - plan 64-63 scratch resolve hook, one rewrite. Mirrors host-voter/authority-hooks.mjs rewrite 3: from the parent
// screens/registration/attach-peer-sync-binding.ts ONLY, the specifier ../../engines/key-vault short-circuits to a data: module. key-vault pulls the
// attestation native module and react-native, neither of which loads in Node; the driver injects resolveVault, so the stub throws only if it is called.
// part1/hr5-hooks.mjs (RN stubs, vote-engine rn entry, re-anchoring) does the rest. It maps no optimystic, cadre or
// protocol-limits path.
let authSrc = ''
export function initialize (data) { authSrc = data?.authSrc ?? '' }
const STUB = 'data:text/javascript,' + encodeURIComponent("export function resolveAuthorityKeyVault () { throw new Error('hr5-part2: resolveVault must be injected') }")

export async function resolve (specifier, context, nextResolve) {
  if (context.parentURL === authSrc + 'screens/registration/attach-peer-sync-binding.ts' && specifier === '../../engines/key-vault') {
    return { url: STUB, shortCircuit: true, format: 'module' }
  }
  return nextResolve(specifier, context)
}
