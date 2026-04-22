export interface Proposal<T> {
  proposed: T
  /** The ids of officers that have signed the proposal */
  signers: string[]
  /** The timestamp when the proposal was made */
  timestamp?: number
}
