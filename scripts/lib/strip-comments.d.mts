// Declarations for scripts/lib/strip-comments.mjs, so TypeScript specs (packages/workflows/test/guards)
// can import the one quote-aware comment stripper with types. The implementation is untouched.

/** Remove every comment from JS/TS/JSX source, preserving line count; `//` inside a string literal survives. */
export function stripComments (source: string): string
