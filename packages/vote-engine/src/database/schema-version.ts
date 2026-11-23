/**
 * The App schema version every VoteTorrent sApp config declares (`SAppConfig.schemaVersion`,
 * required since @serfab 1.24.0). A positive whole number, separate from the sApp `version`
 * release string. Raise it with every change to `packages/vote-core/schema/votetorrent.qsql` that a
 * strand would apply. A strand records the highest version any member applied and refuses to open
 * for an app with a lower one (AppSchemaOutdatedError), so a phone on an older build is told to
 * update rather than dropping a column a newer build added.
 */
export const VOTETORRENT_SCHEMA_VERSION = 1
