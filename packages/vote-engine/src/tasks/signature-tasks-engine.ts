import type {
  ISignatureTasksEngine,
  SignatureResult,
  SignatureTask
} from '@votetorrent/vote-core'

export class SignatureTasksEngine implements ISignatureTasksEngine {
  constructor () {}

  async completeSignature (
    task: SignatureTask,
    result: SignatureResult
  ): Promise<void> {
    throw new Error('Method not implemented.')
  }

  async getRequestedSignatures (pending: boolean): Promise<SignatureTask[]> {
    throw new Error('Method not implemented.')
  }
}
