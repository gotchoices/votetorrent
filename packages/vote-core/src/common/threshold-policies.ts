import type { Scope } from '../authority/models'

export interface ThresholdPolicy {
  /** The threshold policy */
  policy: Scope

  /** The threshold value */
  threshold: number
}
