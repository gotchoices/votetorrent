import type { Database } from '@quereus/quereus'
import type { AdminSignatureTask, SignatureTask, BallotSignatureTask, RegistrantSignatureTask } from '@votetorrent/vote-core'

/**
 * task-signing-status.ts — 62-12 (Surface 5, D-09/D-10/D-11), 62-13 (admin disambiguation).
 *
 * `findPendingTaskNonce` is deliberately a byte-for-byte copy of the three lookup branches
 * `SignatureTasksEngine.getSignatureDigest` uses (`signature-tasks-engine.ts`), so that a
 * `SigningStatus` read through this module always describes exactly the session the officer
 * would sign if they acted on their own pending task right now.
 *
 * 62-13: admin is now disambiguated too, by the SAME (AuthorityId, proposed AdminEffectiveAt)
 * key `completeSignature` and `getSignatureDigest` use — D-09 keeps every reached sibling open,
 * so one officer can hold several pending admin tasks for DIFFERENT proposals at once, and an
 * arbitrary `limit 1` row could describe the wrong one. `findPendingAdminTaskRow` is the ONE
 * shared admin lookup; it is used here ONLY when `task.authority?.id` and
 * `task.administration?.proposed?.effectiveAt` are both defined — otherwise this falls through
 * to the generic branch below (the join-miss base task, WR-01).
 *
 * This module is READ-ONLY: it never inserts, updates or deletes a row, and `findPendingTaskNonce`
 * returns `undefined` instead of throwing when no pending row is found (unlike
 * `getSignatureDigest`, which throws — this module's caller, `getTaskSigningStatus`, needs a
 * fail-open `null`, never an exception, per 62-12's display-only contract).
 *
 * Known residual (not fixed here, inherited from `getSignatureDigest`): the generic (non-ballot,
 * non-registrant, non-disambiguated-admin) branch is ambiguous when a user has two pending tasks
 * of the same `signatureType` — it returns an arbitrary `limit 1` row in that case, exactly as
 * `getSignatureDigest` already does.
 */

/**
 * 62-13 (D-09, T-62-13-04): the ONE admin-task lookup shared by `completeSignature`,
 * `getSignatureDigest` and `findPendingTaskNonce` — keyed on `AdminSignatureTaskExtension`
 * (AuthorityId, AdminEffectiveAt), never an arbitrary `limit 1` row. Returns `undefined`
 * (never throws) when no matching row is found.
 */
export async function findPendingAdminTaskRow (
  db: Database,
  task: AdminSignatureTask
): Promise<{ Id: string; SigningNonce: string } | undefined> {
  const authorityId = task.authority?.id
  const adminEffectiveAt = task.administration?.proposed?.effectiveAt
  if (authorityId === undefined || adminEffectiveAt === undefined) return undefined
  const row = await db
    .prepare(
      `select Task.Id, Task.SigningNonce from Task
        join AdminSignatureTaskExtension E on E.TaskId = Task.Id
        where Task.UserId = :userId
          and Task.Type = 'signature'
          and Task.SignatureType = 'admin'
          and Task.IsCompleted = 0
          and E.AuthorityId = :authorityId
          and E.AdminEffectiveAt = :adminEffectiveAt
        order by Task.Id
        limit 1`
    )
    .get({
      userId: task.userId,
      authorityId,
      adminEffectiveAt,
    }) as { Id: string; SigningNonce: string } | undefined
  return row
}

/**
 * 62-27 (D-11 vrg): the signing nonce of the registrant vrg session behind `requestId`,
 * independent of any one officer's task state (completed or not). Every sibling task of one
 * request shares one nonce (62-11 fan-out). Collects all rows first: exactly one distinct
 * non-empty nonce is returned; zero or several return `undefined` — an ambiguous session is
 * never guessed. Read-only.
 */
export async function findRegistrantSessionNonce (
  db: Database,
  requestId: string
): Promise<string | undefined> {
  const rows: Array<{ SigningNonce: string | null }> = []
  for await (const row of db.eval(
    `select distinct T.SigningNonce as SigningNonce from Task T
      join RegistrantSignatureTaskExtension E on E.TaskId = T.Id
      where E.RequestId = :requestId
        and T.Type = 'signature'
        and T.SignatureType = 'registrant'`,
    { requestId }
  )) {
    rows.push(row as { SigningNonce: string | null })
  }
  const nonces = rows
    .map((r) => r.SigningNonce)
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
  return nonces.length === 1 ? nonces[0] : undefined
}

export async function findPendingTaskNonce (
  db: Database,
  task: SignatureTask
): Promise<string | undefined> {
  if (task.signatureType === 'admin') {
    const authorityId = (task as AdminSignatureTask).authority?.id
    const adminEffectiveAt = (task as AdminSignatureTask).administration?.proposed?.effectiveAt
    if (authorityId !== undefined && adminEffectiveAt !== undefined) {
      const row = await findPendingAdminTaskRow(db, task as AdminSignatureTask)
      return row?.SigningNonce
    }
    // Falls through to the generic branch below — the join-miss base task (WR-01) carries no
    // `authority`, so it cannot be disambiguated and is resolved exactly as before.
  }

  if (task.signatureType === 'ballot') {
    const ballotId = (task as BallotSignatureTask).ballot.proposed.id
    const row = await db
      .prepare(
        `select Task.SigningNonce from Task
          join BallotSignatureTaskExtension E on E.TaskId = Task.Id
          where Task.UserId = :userId
            and Task.Type = 'signature'
            and Task.SignatureType = :signatureType
            and Task.IsCompleted = 0
            and E.BallotId = :ballotId
          limit 1`
      )
      .get({
        userId: task.userId,
        signatureType: task.signatureType,
        ballotId,
      }) as { SigningNonce: string } | undefined
    return row?.SigningNonce
  }

  if (task.signatureType === 'registrant') {
    const requestId = (task as RegistrantSignatureTask).requestId
    const row = await db
      .prepare(
        `select Task.SigningNonce from Task
          join RegistrantSignatureTaskExtension E on E.TaskId = Task.Id
          where Task.UserId = :userId
            and Task.Type = 'signature'
            and Task.SignatureType = :signatureType
            and Task.IsCompleted = 0
            and E.RequestId = :requestId
          limit 1`
      )
      .get({
        userId: task.userId,
        signatureType: task.signatureType,
        requestId,
      }) as { SigningNonce: string } | undefined
    return row?.SigningNonce
  }

  const row = await db
    .prepare(
      `select SigningNonce from Task
        where UserId = :userId
          and Type = 'signature'
          and SignatureType = :signatureType
          and IsCompleted = 0
        limit 1`
    )
    .get({
      userId: task.userId,
      signatureType: task.signatureType,
    }) as { SigningNonce: string } | undefined
  return row?.SigningNonce
}
