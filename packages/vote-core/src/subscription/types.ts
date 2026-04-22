import { type Observable } from 'rxjs'

export interface ISubscriptionEngine {
  watch(id: string, tableName: string): Observable<void>
}
