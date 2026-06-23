## @serfab/strand-proto
THIS MODULE IS DEPRECATED

Configurable invitation-based bootstrap over libp2p to provision a shared Sereus strand (SQL DB), with protocol string override and neutral types.

Terminology (generic):
- Dialog roles: Initiator (dials first), Responder (accepts).
- Mode (who creates the DB):
  - `responderCreates`: Responder provisions and returns info in the Response (2 messages).
  - `initiatorCreates`: Initiator provisions after approval and sends DB info (3 messages).
- Provisioning roles: Creator (provisions), Joiner (uses provision result).

Legacy mapping for MyCHIPs:
- `stock` → `responderCreates`
- `foil` → `initiatorCreates`

### Features
- Session-based state machines (listener/dialer) with timeouts, isolation, and cleanup
- Two flows: responderCreates (2 messages) and initiatorCreates (3 messages with new stream)
- Cadre disclosure timing: initiator discloses first; responder discloses only after validation; no disclosure on rejection
- Hooks interface for token/identity validation and strand provisioning (Quereus/Optimystic)
- Configurable protocol string (default `/sereus/bootstrap/1.0.0`)

### Install

```bash
yarn add @serfab/strand-proto
```

### Usage

```ts
import { createBootstrapManager, DEFAULT_PROTOCOL_ID } from '@serfab/strand-proto'

const hooks = {
  // Prefer new mode; legacy { role: 'stock'|'foil' } is still accepted
  async validateToken(token, sessionId) { return { mode: 'responderCreates', valid: token === 'ok' } },
  async validateIdentity(identity, sessionId) { return true },
  async provisionStrand(creator, a, b, sessionId) {
    return { strand: { strandId: 'str-1', createdBy: creator }, dbConnectionInfo: { endpoint: 'wss://db', credentialsRef: 'creds' } }
  },
  async validateResponse() { return true },
  async validateDatabaseResult() { return true }
}

const mgr = createBootstrapManager(hooks, { protocolId: DEFAULT_PROTOCOL_ID })
// On responder side:
mgr.register(libp2pNode) // or mgr.register(libp2pNode, '/app/bootstrap/1.0.0')

// On initiator side:
const link = { responderPeerAddrs: [addr], token: 'ok', tokenExpiryUtc: new Date().toISOString(), mode: 'responderCreates' as const }
const result = await mgr.initiateBootstrap(link, libp2pNode)
```

### API
- `createBootstrapManager(hooks, config?)` → `SessionManager`
- `SessionManager.register(node, protocolId?)` / `unregister(node, protocolId?)`
- `SessionManager.initiateBootstrap(link, node)` → `{ strand, dbConnectionInfo }`

Types: see `src/bootstrap.ts`.

### Notes
- Applications may use their own protocol IDs; pass via `config.protocolId` and/or `BootstrapLink.protocolId`.
- The library is role-agnostic; `'stock'|'foil'` are logical roles that control which side provisions.
- Multi-party bootstrap can be layered above by iterating invites and finalizing once quorum reached.


