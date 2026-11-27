/**
 * strand-changes.ts — the app binding of the process's one strand change hub, which now lives in
 * @votetorrent/workflows common/strand-changes.ts. This path stays so `useStrandChanges`, `ResultsScreen`
 * and the tests import it unchanged, and it re-exports the SAME `strandChanges` object (never a wrapper).
 *
 * The shared module reads no build-mode global, so this binding installs the dev-only reporter at module
 * load. Errors are logged in development builds only, by label and error class, never with row data.
 */
import { strandChanges, setStrandChangeErrorReporter } from '@votetorrent/workflows';

setStrandChangeErrorReporter((label, err) => {
	if (__DEV__) {
		console.warn(`[strand-changes] ${label}: ${err instanceof Error ? err.name : typeof err}`);
	}
});

export { strandChanges };
