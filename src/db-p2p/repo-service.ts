import { pipe } from 'it-pipe'
import { decode as lpDecode, encode as lpEncode } from 'it-length-prefixed'
import { type Startable, type Logger, serviceSymbol, serviceDependencies, start, stop } from '@libp2p/interface'
import type { IncomingStreamData, Components } from '@libp2p/interface-internal'
import { RepoMessage } from '../db-core/network/repo-protocol.js'
import { Repo } from '../db-core/index.js'

export interface RepoServiceInit {
  protocol?: string
  maxInboundStreams?: number
  maxOutboundStreams?: number
  logPrefix?: string
}

export interface RepoServiceComponents extends Components {
  repo: Repo
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
  private running: boolean

  constructor(components: RepoServiceComponents, init: RepoServiceInit = {}) {
    this.protocol = init.protocol ?? '/db-p2p-repo/1.0.0'
    this.maxInboundStreams = init.maxInboundStreams ?? 32
    this.maxOutboundStreams = init.maxOutboundStreams ?? 64
    this.log = components.logger.forComponent(init.logPrefix ?? 'db-p2p:repo-service')
    this.repo = components.repo
    this.running = false
  }

  readonly [Symbol.toStringTag] = '@libp2p/repo-service'
  readonly [serviceSymbol] = true
  readonly [serviceDependencies] = []

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
