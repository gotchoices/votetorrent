import { pipe } from 'it-pipe'
import { decode as lpDecode, encode as lpEncode } from 'it-length-prefixed'
import { type Startable, type Logger } from '@libp2p/interface'
import type { IncomingStreamData } from '@libp2p/interface-internal'
import { RepoMessage } from '../../db-core/src/network/repo-protocol.js'
import { Repo } from './index.js'
import { ICluster } from '../../db-core/cluster/i-cluster.js'

// Define Components interface
interface BaseComponents {
  logger: { forComponent: (name: string) => Logger }
  registrar: {
    handle: (protocol: string, handler: (data: IncomingStreamData) => void, options: any) => Promise<void>
    unhandle: (protocol: string) => Promise<void>
  }
}

export interface RepoServiceComponents extends BaseComponents {
  repo: Repo
  cluster: ICluster
}

export interface RepoServiceInit {
  protocol?: string
  maxInboundStreams?: number
  maxOutboundStreams?: number
  logPrefix?: string
}

/**
 * A libp2p service that handles repo protocol messages
 */
export class RepoService implements Startable {
  private readonly protocol: string
  private readonly maxInboundStreams: number
  private readonly maxOutboundStreams: number
  private readonly log: Logger
  private readonly repo: Repo
  private readonly components: RepoServiceComponents
  private running: boolean

  constructor(components: RepoServiceComponents, init: RepoServiceInit = {}) {
    this.components = components
    this.protocol = init.protocol ?? '/db-p2p-repo/1.0.0'
    this.maxInboundStreams = init.maxInboundStreams ?? 32
    this.maxOutboundStreams = init.maxOutboundStreams ?? 64
    this.log = components.logger.forComponent(init.logPrefix ?? 'db-p2p:repo-service')
    this.repo = components.repo
    this.running = false
  }

  readonly [Symbol.toStringTag] = '@libp2p/repo-service'

  /**
   * Start the service
   */
  async start(): Promise<void> {
    if (this.running) {
      return
    }

    await this.components.registrar.handle(this.protocol, this.handleIncomingStream.bind(this), {
      maxInboundStreams: this.maxInboundStreams,
      maxOutboundStreams: this.maxOutboundStreams
    })

    this.running = true
  }

  /**
   * Stop the service
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return
    }

    await this.components.registrar.unhandle(this.protocol)
    this.running = false
  }

  /**
   * Handle incoming streams on the repo protocol
   */
  private handleIncomingStream(data: IncomingStreamData): void {
    const { stream, connection } = data
    const peerId = connection.remotePeer

    Promise.resolve().then(async () => {
      await pipe(
        stream,
        (source) => lpDecode(source),
        async function* (source) {
          for await (const msg of source) {
            // Decode the message
            const decoded = new TextDecoder().decode(msg.subarray())
            const message = JSON.parse(decoded) as RepoMessage

            // Process each operation
            const operation = message.operations[0]
            let response: any

            if ('get' in operation) {
              response = await this.repo.get(operation.get, {
                expiration: message.expiration
              })
            } else if ('pend' in operation) {
              response = await this.repo.pend(operation.pend, {
                expiration: message.expiration
              })
            } else if ('cancel' in operation) {
              response = await this.repo.cancel(operation.cancel, {
                expiration: message.expiration
              })
            } else if ('commit' in operation) {
              response = await this.repo.commit(operation.commit, {
                expiration: message.expiration
              })
            }

            // Encode and yield the response
            yield new TextEncoder().encode(JSON.stringify(response))
          }
        }.bind(this),
        (source) => lpEncode(source),
        stream
      )
    }).catch(err => {
      this.log.error('error handling repo protocol message from %p - %e', peerId, err)
    })
  }
}
