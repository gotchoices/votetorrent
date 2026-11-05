/**
 * websocket-batching.js — WebSocket sends, batched: the binary sends made in one turn go to
 * native code as ONE message.
 *
 * PORTED from sereus-chat `packages/core/src/transport/websocket-batching.ts` (c9a02d3), with
 * its types removed and its install tag renamed. sereus-chat installs it in its NativeScript
 * app (`apps/mobile-ns/src/polyfills/chat.ts`). BYTE-IDENTICAL in both apps;
 * polyfills/__tests__/websocket-batching.test.js guards that. polyfills.bootstrap.js installs it
 * on `WebSocket.prototype` behind its WEBSOCKET_SEND_BATCHING constant.
 *
 * WHY. libp2p's WebSocket connection sends each chunk of a write as its own message
 * (`@libp2p/websockets` `sendData` loops `websocket.send(buf)`), and about half are 16 bytes or
 * fewer (Noise length prefixes, yamux headers). Every message is a crossing into native code,
 * and React Native's `WebSocket.send` base64-encodes each binary message on the JS thread
 * first (`NativeWebSocketModule.sendBinary(binaryToBase64(data))`). The Redmi's 2026-10 profile
 * listed those base64 bridge sends among its JS-thread costs. libp2p reads a WebSocket as a
 * byte stream, so message boundaries carry nothing: binary sends made in one turn are joined
 * and sent once, in a microtask, in order. A text send, or `close()`, sends what is waiting
 * first.
 *
 * MEASURED ONLY ON NATIVESCRIPT: 62% fewer native sends on a Galaxy S7, while joining and while
 * idle (sereus-chat docs/STATUS.md). sereus-chat's one React Native A/B (S7, release) was
 * inconclusive, and it does not install this in its RN app. UNVERIFIED on React Native here:
 * it needs a device measurement (bridge sends and JS time, with the constant on and off).
 *
 * Pure: touches no global until `batchWebSocketSends` is called, so jest drives it with a fake
 * socket class.
 */

const INSTALLED = Symbol.for('votetorrent/websocket-batching');

/**
 * Wrap `proto.send` and `proto.close` (normally `WebSocket.prototype`). Idempotent.
 * `onNativeSend`, if given, is told the size of each message that really goes out.
 */
function batchWebSocketSends(proto, onNativeSend) {
	if (proto[INSTALLED]) return;
	proto[INSTALLED] = true;
	const nativeSend = proto.send;
	const nativeClose = proto.close;
	const send = (ws, data) => {
		if (onNativeSend) onNativeSend(data?.byteLength ?? data?.length ?? 0);
		nativeSend.call(ws, data);
	};
	const waiting = new WeakMap();
	const flush = ws => {
		const parts = waiting.get(ws);
		if (!parts) return;
		waiting.delete(ws);
		if (parts.length === 1) return send(ws, parts[0]);
		let size = 0;
		for (const p of parts) size += p.byteLength;
		const joined = new Uint8Array(size);
		let at = 0;
		for (const p of parts) {
			joined.set(p, at);
			at += p.byteLength;
		}
		send(ws, joined);
	};
	proto.send = function (data) {
		if (!(data instanceof ArrayBuffer || ArrayBuffer.isView(data))) {
			flush(this);
			return send(this, data);
		}
		// A copy: the caller may reuse its buffer once send() returns.
		const bytes = data instanceof ArrayBuffer
			? new Uint8Array(data.slice(0))
			: new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
		let parts = waiting.get(this);
		if (!parts) {
			waiting.set(this, (parts = []));
			void Promise.resolve().then(() => flush(this));
		}
		parts.push(bytes);
	};
	proto.close = function (...args) {
		flush(this);
		return nativeClose.apply(this, args);
	};
}

module.exports = { batchWebSocketSends };
