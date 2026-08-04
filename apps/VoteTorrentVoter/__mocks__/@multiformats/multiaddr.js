/**
 * @format
 *
 * Phase 39 plan 39-04 (DEBT-09 app-Jest gate) — Jest mock for
 * @multiformats/multiaddr. ESM-only (no "require" export condition), so it
 * is unresolvable under the react-native Jest CommonJS resolver.
 * App.test.tsx's full navigation tree transitively imports it via
 * NetworksScreen.tsx. Mirrors the faithful throw-on-garbage / decode-/p2p/
 * behavior already pinned locally in NetworksScreen.bootstrap.test.tsx
 * (that file's own inline jest.mock takes precedence when it runs).
 */
module.exports = {
  multiaddr: (input) => {
    if (typeof input !== 'string' || !input.startsWith('/') || input.trim() === '/') {
      throw new Error('InvalidMultiaddrError: invalid multiaddr');
    }
    const segments = input.split('/').filter(Boolean);
    const components = [];
    for (let i = 0; i < segments.length; i++) {
      if (segments[i] === 'p2p') {
        const value = segments[i + 1];
        if (!value) throw new Error('InvalidMultiaddrError: missing p2p value');
        components.push({ name: 'p2p', value });
        i++;
      } else {
        components.push({ name: segments[i], value: segments[i + 1] });
      }
    }
    return { getComponents: () => components };
  },
};
