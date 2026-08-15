# Planning poker

A small planning-poker table. Create a session, share the URL, people join with
a display name, vote in private, reveal together, then save who voted what
against a ticket id.

No accounts. The board id is 128 bits of randomness; treat the URL as the
secret.

It runs on Cloudflare: a Worker serves the UI and API, a Durable Object holds
each live table, and D1 stores saved history. A daily cron deletes sessions
that have not been used for two weeks — history included. The current ticket
(votes, phase, the ticket field) is not stored in D1. Saving a result keeps
only that completed round; starting the next ticket throws the live hand away.

## How a session works

1. Create a session (optional name, pick a deck).
2. Share the link. Everyone types a name. The eye card watches without voting.
3. Name the current ticket (usually a Jira id).
4. Vote. You can change your card until someone hits **Reveal cards**. Anyone
   at the table can reveal. `?` and `☕` show immediately (same dashed style as
   the eye); numbers stay hidden. `☕` sits the round out and drops you from
   the voter count. `?` keeps you in the count but is not a vote — you don't
   understand the ticket yet.
5. After the reveal, votes stay face-up and people can still change them while
   you discuss. The table shows the average. **Pick agreed estimate** locks
   votes; then choose the agreed card and **Save result & next ticket**.
   Individual votes are stored with the agreed value. `☕` stays put if you
   vote again; number votes are cleared.
6. Repeat for the next ticket. Open **History** (next to the theme toggle) to
   see every saved round and who voted what. Unsaved work from the previous
   ticket is gone.

The deck can be changed on the table at any time. Cards that are not in the new
deck are dropped.

Built-in decks: Fibonacci (includes `½`), modified Fibonacci, powers of 2,
T-shirt. Every deck includes `?` and `☕`.

## Run it

Needs Node 22+.

```sh
npm install
npx wrangler types --include-runtime=false
npm test
npm run dev
```

`npm run dev` applies the D1 migrations to the local database before starting Vite. Run `npm run db:migrate` directly when you only want to update the local database.

Then open the URL Vite prints (usually <http://127.0.0.1:5173/>).

## Deploy

```sh
npx wrangler login
npx wrangler d1 create planning-poker
```

Put the printed `database_id` in `wrangler.jsonc`, then:

```sh
npm run deploy
```

Point the Worker at your hostname in the Cloudflare dashboard (or
`wrangler.jsonc` `routes`).

The cleanup cron runs daily at 04:00 UTC and deletes any session whose
`last_used_at` is older than 14 days.

## Design system

UI styles follow the shared ai-tools design system
([`~/w/ai-tools/style`](../ai-tools/style)):

- `src/styles/tokens.css` and `src/styles/components.css` are **vendored** —
  never edit them by hand.
- Re-sync with:

  ```sh
  ~/w/ai-tools/bin/sync-style src/styles
  ```

- App-only rules live in `src/styles/app.css` and use **tier-2 semantic
  tokens** only (`--color-*`, `--space-*`, `--font-*`, …).
- Dark mode is `data-theme="dark"` on `<html>` (sun/moon toggle in the header).
  The first visit follows `prefers-color-scheme`; after that the choice is
  stored in `localStorage`.

## Checks

```sh
npm test
npm run typecheck
```
