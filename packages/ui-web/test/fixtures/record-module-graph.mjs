#!/usr/bin/env node
/**
 * record-module-graph.mjs -- a child-process module-graph recorder (D-19
 * runtime proof, Phase 59 plan 59-02, group B).
 *
 * Takes one bare specifier as `process.argv[2]`, registers a `node:module`
 * customization hook via `register()` that intercepts every `resolve()` call
 * Node's ESM loader makes while satisfying that one `import()`, and prints
 * the full list of resolved URLs as JSON on stdout.
 *
 * `register()`'s hooks run on a dedicated loader thread by default (Node's
 * own module-customization-hooks design) -- the ONLY documented channel back
 * to the main thread is a `MessagePort`, handed to the hook module's
 * `initialize(data)` export via `register()`'s `data`/`transferList` options.
 * The inline hook module below is therefore passed as a `data:` URL rather
 * than a separate file: a `data:` URL still runs as its own ES module and
 * still receives `initialize(data)`/`resolve(...)` calls exactly like a file
 * on disk would, with no extra fixture file to keep in sync with this one.
 *
 * This script MUST run as its own process per specifier -- `register()` is
 * process-wide, so two arms sharing one process would pool their graphs into
 * one list and neither the D-19 "resolves to nothing but itself" assertion
 * nor the `./lifecycle` positive control could tell which specifier produced
 * which URL.
 *
 * Node's declared engine here is `>=20.19`, so `module.register` is
 * available without any CLI loader flag.
 */
import { register } from 'node:module';
import { MessageChannel } from 'node:worker_threads';

const specifier = process.argv[2];
if (!specifier) {
	console.error('usage: record-module-graph.mjs <bare-specifier>');
	process.exit(1);
}

const { port1, port2 } = new MessageChannel();

/** @type {string[]} */
const resolvedUrls = [];
port1.on('message', (url) => {
	resolvedUrls.push(url);
});
port1.unref();

// The hook module: forwards every resolved URL over the port it receives in
// `initialize(data)`. `resolve()` must still call `nextResolve` and return
// its result unchanged -- this hook OBSERVES the resolution chain, it must
// never alter it.
const hookSource = [
	'let port;',
	'export function initialize(data) { port = data.port; }',
	'export async function resolve(specifier, context, nextResolve) {',
	'  const result = await nextResolve(specifier, context);',
	'  if (port) port.postMessage(result.url);',
	'  return result;',
	'}',
].join('\n');

register(`data:text/javascript,${encodeURIComponent(hookSource)}`, {
	parentURL: import.meta.url,
	data: { port: port2 },
	transferList: [port2],
});

await import(specifier);

// `postMessage` delivery across the MessageChannel is asynchronous relative
// to the hook thread that sends it -- `import()` resolving on the main
// thread does not guarantee every already-sent message has been DELIVERED
// here yet. A short flush window is the standard mitigation for this class
// of cross-thread channel (there is no "hooks thread is idle" signal to
// await instead).
await new Promise((resolve) => setTimeout(resolve, 100));

process.stdout.write(JSON.stringify(resolvedUrls));
