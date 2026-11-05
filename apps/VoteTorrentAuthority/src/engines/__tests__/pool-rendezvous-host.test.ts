/**
 * The Authority hosts its voters' pool rendezvous (spike 102): it answers on the control node and
 * admits only its own cadre's members.
 */
import {POOL_RENDEZVOUS_PROTOCOL, createPoolIdentity, poolRequests} from '@votetorrent/vote-engine/rn';
import {hostPoolRendezvous} from '../pool-rendezvous-host';

function fakeControl() {
	const handlers = new Map<string, (stream: unknown, connection: unknown) => void>();
	return {
		handlers,
		handle: jest.fn(async (protocol: string, handler: (s: unknown, c: unknown) => void) => { handlers.set(protocol, handler); }),
		unhandle: jest.fn(async (protocol: string) => { handlers.delete(protocol); }),
		dialProtocol: jest.fn(),
	};
}

/** A one-request stream: yields the request frame, captures the reply frame. */
function requestStream(request: unknown) {
	const body = new TextEncoder().encode(JSON.stringify(request));
	const frame = new Uint8Array(4 + body.length);
	new DataView(frame.buffer).setUint32(0, body.length, false);
	frame.set(body, 4);
	let reply: unknown;
	let resolveReply: () => void = () => undefined;
	const replied = new Promise<void>(r => { resolveReply = r; });
	return {
		stream: {
			[Symbol.asyncIterator]: () => {
				let sent = false;
				return {next: async () => (sent ? new Promise(() => undefined) : (sent = true, {done: false, value: frame}))};
			},
			send: (bytes: Uint8Array) => { reply = JSON.parse(new TextDecoder().decode(bytes.subarray(4))); resolveReply(); },
			close: async () => undefined,
			abort: () => resolveReply(),
		},
		replied,
		reply: () => reply,
	};
}

describe('hostPoolRendezvous (spike 102)', () => {
	it('serves the pool protocol on the control node, to members only, and detaches cleanly', async () => {
		const control = fakeControl();
		const members = new Set(['member-peer']);
		const detach = await hostPoolRendezvous({
			peerId: {toString: () => 'authority-peer'},
			getControlNode: () => control,
			isAuthorizedMember: async (p) => members.has(p),
		});
		const handler = control.handlers.get(POOL_RENDEZVOUS_PROTOCOL);
		expect(handler).toBeDefined();
		const identity = createPoolIdentity();

		const asMember = requestStream(poolRequests.present(identity, 'topic', 1, Date.now()));
		handler!(asMember.stream, {remotePeer: {toString: () => 'member-peer'}});
		await asMember.replied;
		expect(asMember.reply()).toEqual({t: 'coordinators', list: []});

		const asStranger = requestStream(poolRequests.present(identity, 'topic', 1, Date.now()));
		handler!(asStranger.stream, {remotePeer: {toString: () => 'stranger-peer'}});
		await asStranger.replied;
		expect(asStranger.reply()).toEqual({t: 'error', reason: 'not allowed'});

		await detach();
		expect(control.unhandle).toHaveBeenCalledWith(POOL_RENDEZVOUS_PROTOCOL);
	});

	it('refuses to attach before the control node runs', async () => {
		await expect(hostPoolRendezvous({peerId: {toString: () => 'p'}, getControlNode: () => null, isAuthorizedMember: () => false}))
			.rejects.toThrow('control node is not running');
	});
});
