# Planning poker

A small planning-poker table for a team on a VPC. Create a session, share the
URL, people join with a display name, vote in private, reveal together, then
save who voted what against a ticket id.

No accounts. The board id is 128 bits of randomness; treat the URL as the
secret. Storage is a SQLite file on disk.

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
   see every saved round and who voted what.

The deck can be changed on the table at any time. Cards that are not in the new
deck are dropped.

Built-in decks: Fibonacci (includes `½`), modified Fibonacci, powers of 2,
T-shirt. Every deck includes `?` and `☕`.

## Run it

Needs a recent Rust toolchain and Node 22+.

```sh
cd frontend
npm install
npm run build
cd ..

cargo run --release
```

Then open <http://127.0.0.1:3000/>.

During UI work, run the API and Vite together:

```sh
cargo run
```

```sh
cd frontend
npm install
npm run dev
```

Vite proxies `/api` and `/ws` to `127.0.0.1:3000`.

## Design system

UI styles follow the shared ai-tools design system
([`~/w/ai-tools/style`](../ai-tools/style)):

- `frontend/src/styles/tokens.css` and `frontend/src/styles/components.css`
  are **vendored** — never edit them by hand.
- Re-sync with:

  ```sh
  ~/w/ai-tools/bin/sync-style frontend/src/styles
  ```

- App-only rules live in `frontend/src/styles/app.css` and use **tier-2
  semantic tokens** only (`--color-*`, `--space-*`, `--font-*`, …).
- Dark mode is `data-theme="dark"` on `<html>` (sun/moon toggle in the header).
  The first visit follows `prefers-color-scheme`; after that the choice is
  stored in `localStorage`.

### Environment

| Variable         | Default               | Meaning                          |
| ---------------- | --------------------- | -------------------------------- |
| `LISTEN`         | `127.0.0.1:3000`      | Bind address                     |
| `DATABASE_PATH`  | `planning-poker.db`   | SQLite file                      |
| `STATIC_DIR`     | `static`              | Built frontend (`npm run build`) |
| `RUST_LOG`       | `info`                | `tracing` filter                 |

On a VPC, bind all interfaces and put the database on persistent disk:

```sh
LISTEN=0.0.0.0:3000 DATABASE_PATH=/var/lib/planning-poker/app.db cargo run --release
```

## Checks

```sh
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

cd frontend && npm run typecheck
```
