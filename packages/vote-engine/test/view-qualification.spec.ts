/**
 * view-qualification.spec.ts — Phase 32 Plan 01 (UPG-01 RED gate)
 *
 * Purpose: Assert that declared App-schema views are created as App.X (not main.X)
 * under `apply schema App`. On bare quereus 4.2.1 (no applyViewDefaults patch) this
 * FAILS (RED). On the patched 4.x version (Plan 02) it turns GREEN.
 *
 * Scope:
 *  - Primary gate (criterion #1): `App.CurrentAdmin` creates and resolves under
 *    `apply schema App` with no view-DDL error.
 *  - Secondary non-gating measurement (D-04): `AcceptedInvite` create status
 *    observed separately — its body defect (`AdminSigning.SigningNonce` column
 *    does not exist) is a pre-existing issue distinct from the qualification gap.
 *
 * See:
 *  - 32-RESEARCH.md §Targeted View-DDL Test Shape (Code Examples)
 *  - 32-PATTERNS.md §view-qualification.spec.ts
 *  - networks.spec.ts REL-01 makeStrandDb (962–1037) — import/strip/builder analogs
 */

import { expect } from 'chai'
import { Database } from '@quereus/quereus'
import { registerDbPlugins } from '../src/database/initialize.js'
import { VOTETORRENT_SCHEMA_SQL } from '../src/database/schema-sql.js'

// Strip the outer `declare schema main { ... } apply schema main;` wrapper.
// Exact two-regex strip copied verbatim from networks.spec.ts:968–971 (same regex
// used by rn-db-factory.ts in the production strand path).
const VOTETORRENT_INNER_DDL = VOTETORRENT_SCHEMA_SQL
  .replace(/^\s*declare\s+schema\s+\w+\s*\{/, '')
  .replace(/\}\s*apply\s+schema\s+\w+\s*;\s*$/, '')
  .trim();

/**
 * Simulate the strand-path Database: App-schema declaration + apply + schema path set.
 * Mirrors exactly what StrandDatabase.initialize() + executeSchema() leave behind.
 * Analog: networks.spec.ts makeStrandDb (962–984).
 */
async function makeStrandDb(): Promise<Database> {
  const db = new Database();
  await registerDbPlugins(db);
  await db.exec(`declare schema App { ${VOTETORRENT_INNER_DDL} } apply schema App;`);
  db.setSchemaPath(['App', 'main']);
  return db;
}

describe('view-qualification (UPG-01)', () => {

  it('applyViewDefaults: declared views create as App.X (not main.X) under apply schema App', async () => {
    // On bare quereus 4.2.1 this FAILS (RED) because `schema-differ.js` has no
    // `applyViewDefaults` — views are pushed unqualified and default to `main`, so
    // `App.CurrentAdmin` / `App.Admin` are not found on the App schema path.
    // After Plan 02 forward-ports the patch, this turns GREEN.
    const db = new Database();
    await registerDbPlugins(db);

    let caughtError: unknown;
    try {
      // Previously threw "Table 'Admin' not found in schema path: App":
      await db.exec(`declare schema App { ${VOTETORRENT_INNER_DDL} } apply schema App;`);
      db.setSchemaPath(['App', 'main']);
      // Prove App.CurrentAdmin resolves under App (qualified), not only via the
      // declareViewsInMain workaround. Row may be undefined on empty tables —
      // existence (no error) is the signal.
      await db.prepare('select * from App.CurrentAdmin limit 1').get();
    } catch (err) {
      caughtError = err;
    }

    expect(
      caughtError,
      'CurrentAdmin must create + resolve as App.CurrentAdmin with no view-DDL error (UPG-01)',
    ).to.equal(undefined);
  });

  it('applyViewDefaults: AcceptedInvite body-defect status (non-gating D-04 measurement)', async () => {
    // SEPARATE non-gating measurement per D-04 / Pitfall 2:
    // `AcceptedInvite` joins `AdminSigning SIG on SIG.SigningNonce = S.SigningNonce` but
    // `AdminSigning` has no `SigningNonce` column (PK is `Nonce`). This is a pre-existing
    // view-body defect, already documented in declareViewsInMain's doc-comment. On bare 4.x
    // the failure is a hard DDL abort (not masked by try/catch the way 3.3.0 does it).
    // This test OBSERVES and logs the status so Plan 02/03 can triage D-04 residue,
    // but it does NOT gate criterion #1 (CurrentAdmin qualification) on AcceptedInvite.
    //
    // Expected behaviour on bare 4.x:
    //   caughtError.message contains "SIG.SigningNonce isn't a column"
    // Expected behaviour after the differ patch (Plan 02):
    //   caughtError.message still contains "SIG.SigningNonce isn't a column"
    //   (the body defect is orthogonal to schema qualification)
    // Expected behaviour after D-04 fix (AcceptedInvite join corrected):
    //   caughtError === undefined (both gates pass)
    const db = new Database();
    await registerDbPlugins(db);

    let caughtError: unknown;
    try {
      await db.exec(`declare schema App { ${VOTETORRENT_INNER_DDL} } apply schema App;`);
    } catch (err) {
      caughtError = err;
    }

    // Non-gating: log the AcceptedInvite status for Plan 02/03 triage.
    if (caughtError) {
      const msg = caughtError instanceof Error ? caughtError.message : String(caughtError);
      console.log('[D-04 measurement] AcceptedInvite create error observed:', msg.slice(0, 200));
    } else {
      console.log('[D-04 measurement] AcceptedInvite create: no error (body defect resolved or masked)');
    }

    // This assertion is intentionally relaxed — it only confirms we measured something.
    // The gating criterion (#1, CurrentAdmin) is the previous test.
    expect(true, 'D-04 measurement recorded (see console output above)').to.equal(true);
  });

});
