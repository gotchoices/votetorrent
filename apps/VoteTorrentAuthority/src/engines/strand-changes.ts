/**
 * strand-changes.ts — the app binding of the process's one strand change hub, which now lives in
 * @votetorrent/workflows common/strand-changes.ts. This path stays so `useStrandChanges`, `pair-mint-host`
 * and the tests import it unchanged, and it re-exports the SAME `strandChanges` object (never a wrapper:
 * pair-mint-host.test spies on its `subscribe`).
 *
 * The shared module reads no build-mode global, so this binding installs the dev-only reporter at module
 * load: in development builds a hub error is logged by label and error class, never with row data; release
 * builds stay silent exactly as before.
 */
import { strandChanges, setStrandChangeErrorReporter } from '@votetorrent/workflows';

setStrandChangeErrorReporter((label, err) => {
	if (__DEV__) {
		console.warn(`[strand-changes] ${label}: ${err instanceof Error ? err.name : typeof err}`);
	}
});

export { strandChanges };
