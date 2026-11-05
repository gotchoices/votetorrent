## Tickets (tess)

Project uses [tess](tess/) for AI-driven ticket management.
Read + follow ticket workflow rules in tess/agent-rules/tickets.md.
Tickets in [tickets/](tickets/) directory.
If asked to "tend the garden" or similar, see tess/agent-rules/tend.md.

## Code search (tess)

**First tool** for any "where / how / why" question about this codebase: local code-aware index wired to `mcp__code-search__*`. Reach for `grep`/`Glob` only when you know exact filename or literal string. Pick right sub-tool — not interchangeable.

**Decision rule:**

- Query identifier-shaped (single symbol, camelCase, snake_case, or name list like `fooBar bazQux`)? → `find_references`.
- Query prose ("where do we evict pages", "what handles JWT refresh", identifier unknown)? → `search_code`.
- About to run more than one `grep` to reconstruct context? → run `search_code` first instead. Payoff moment, even when you know an identifier.

`search_code` embeds query as natural language. Identifier-bag queries can work when identifiers co-locate in real code, but prose phrasing more reliable. If `search_code` returns weak-top warning, relative-percentage ranking unreliable — switch to `find_references` or rephrase as prose. Do **not** trust ordering on noisy results.

**Tools:**

- `search_code(query, k?, path_filter?)` — semantic search. Scores relative within each result set, not absolute. `k` defaults to 5 (max 50) — raise for broad sweeps, lower when top hit enough. `path_filter` is SQL LIKE pattern, e.g. `"packages/lamina/%"`.
- `find_references(symbol, max?, path_filter?)` — literal substring; `|` ORs alternatives (`Foo|Bar`). Returns every hit (capped by `max`, default 50, max 500). Indexed replacement for `grep` on identifiers.
- `read_chunk(path, start_line, end_line)` — expand snippet from either tool without separate `Read`.

**Fallbacks:**

- Use `grep`/`Glob` only for filename patterns, regex with anchors/lookarounds, or when you need *every* literal hit (index is chunk-granular, may miss adjacent matches inside one chunk).
- Never fall back to `grep` when `find_references` suffices — strictly slower, pulls more bytes.

**What's indexed:** git-tracked project source, minus `node_modules/`, `dist/`, `build/`, `.git/`, `tickets/`, `team/`, `docs/`, few cache dirs. If query about prose-heavy material (long-form architecture docs, design notes, nested READMEs) returns nothing, file may be outside indexed set — fall back to `Read`/`Glob` for those paths. Projects can override filter via `tickets/index-config.json` (see tess README § Customize what gets indexed).
