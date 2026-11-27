// Declarations for scripts/lib/dist-freshness.mjs, so TypeScript specs (packages/workflows/test) can
// import `staleDistFiles` with types. The implementation lives in the .mjs file; keep both in step.

export type DistProblemKind = 'missing' | 'stale' | 'leftover'

export interface DistProblem {
  kind: DistProblemKind
  /** Package-relative POSIX path: `src/<rel>.ts` for missing/stale, `dist/<rel>.js` for leftover. */
  file: string
}

export interface DistFreshness {
  /** false when `<packageRoot>/dist` does not exist; `problems` is then empty. */
  distPresent: boolean
  /** Sorted by `file`. */
  problems: DistProblem[]
}

/** Compare `<packageRoot>/dist` with `<packageRoot>/src` file by file. Throws when src is absent. */
export function staleDistFiles (packageRoot: string): DistFreshness
