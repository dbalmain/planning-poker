# REVIEW.md — planning-poker review notes

Repo-specific review guidance, accumulated by the review-craft skill. The skill
reads **Standing checks** before every review and appends to the **Findings
log** when a review uncovers a durable lesson. Keep entries terse.

## Standing checks

Mandatory extra criteria every review applies here (promoted from recurring
findings). Each should name the guard that will eventually retire it.

- **One definition of the schema.** Any DDL outside `migrations/` is a finding.
  Tests apply `migrations/`, so a second copy elsewhere is never exercised.
  _Guard: no DDL string outside `migrations/*.sql` (grep in CI)._
- **The tested path must be the production path.** For every entry point, check
  that the sequence the tests drive is the sequence the Worker/DO actually
  calls. Convenience wrappers used only by tests are a finding, not a nicety.
  _Guard: none yet — needs a dead-export check (`knip` or similar)._
- **No D1 write on the real-time path.** WebSocket handling must not `await` D1
  before broadcasting. Bookkeeping writes (`last_used_at`) must be throttled
  against the granularity they actually serve. _Guard: none yet._
- **A URL shape gets one definition in `shared/`.** Path regexes duplicated
  across `worker/`, `src/` and `wrangler.jsonc` are a finding. _Guard: none yet
  — a lint rule banning literal path regexes outside `shared/routes.ts` would do
  it._

## Findings log

### 2026-08-15 — Rust → Cloudflare Workers migration (first review of this repo)

- **What:** schema defined twice (`worker/db.ts` `ensureSchema` vs
  `migrations/0001_init.sql`), with the DDL copy running on the request path and
  the migrations copy being the only one tests exercise; a D1 `touchBoard` write
  awaited before every WebSocket broadcast; `Board.confirmRound` reachable only
  from tests while production uses `buildCompletedRound` + `startNextTicket`;
  the board-id path regex written seven times; raw internal error messages
  returned to clients; no linter, no formatter, no CI.
- **Why missed:** first review — the migration landed as one uncommitted tree
  with no prior review pass.
- **Guard:** promoted the first four to Standing checks above. eslint
  (`strictTypeChecked`, `no-floating-promises`, `switch-exhaustiveness-check`)
  - prettier + a CI `check` job ported from `../totp-tester` cover the tooling
    floor; a `rounds` row-count assertion in the cleanup test covers the
    `ON DELETE CASCADE` that the current 404-only assertion cannot see.

### 2026-08-15 — Test asserted a symptom that survives the bug

- **What:** `test/worker.test.ts` "deletes unused sessions and their history"
  asserted only that `GET /history` returns 404. That 404 comes from the missing
  **board** row; the `rounds` rows it claims to check are never counted, so a
  non-firing `ON DELETE CASCADE` leaves orphans and the test still passes.
- **Why missed:** first sighting. The failure mode is a test whose assertion is
  reachable through a shorter path than the behaviour it names.
- **Guard:** assert the row count directly. Generally: when a test names two
  effects, assert both — a 404 that any one of several causes can produce is not
  evidence for the specific cause.
