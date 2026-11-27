/**
 * wire.mjs — the line protocol between a gate and a peer agent.
 *
 * WHY A LINE PROTOCOL AND NOT `child_process.fork()` IPC
 * ------------------------------------------------------
 * `fork()`'s channel is a Node-to-Node private fd. It works for a local child and for
 * NOTHING else. The whole point of running each node in its own process is to be able to
 * move that process somewhere else — another host over ssh, a second machine on a real
 * NIC behind a real NAT — and the moment the transport is `ssh host node peer-agent.mjs`
 * there is no fd 3, only stdin and stdout.
 *
 * So: newline-delimited JSON, each frame prefixed with a sentinel. Anything on the stream
 * that is not a frame is somebody's log line and is forwarded, not parsed. That keeps the
 * channel usable over any byte pipe that preserves lines, which is the lowest common
 * denominator every remote transport actually offers.
 */
export const SENTINEL = '#MPG#';

export function encodeFrame(obj) {
  return `${SENTINEL} ${JSON.stringify(obj)}\n`;
}

/**
 * Split a chunk stream into frames and passthrough lines.
 *
 * Returns a function to feed chunks into; it invokes `onFrame` for decoded frames and
 * `onNoise` for every other line. A frame that fails to parse is noise, never a throw —
 * a corrupted line must not take the harness down with it.
 */
export function createFrameReader({ onFrame, onNoise = () => {} }) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith(SENTINEL)) { onNoise(line); continue; }
      try {
        onFrame(JSON.parse(line.slice(SENTINEL.length)));
      } catch (e) {
        onNoise(`${line}   (undecodable frame: ${e?.message ?? e})`);
      }
    }
  };
}
