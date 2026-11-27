/**
 * Trivial zero-hook function component. There is deliberately no
 * `FixtureProbe.js` sibling on disk — resolving `./FixtureProbe.js` to this
 * `.tsx` file is a bundler-only behaviour, and plain Node's inability to do
 * so is exactly what makes the `ERR_MODULE_NOT_FOUND` positive control real.
 */
export function FixtureProbe() {
	return <div>fixture probe</div>;
}
