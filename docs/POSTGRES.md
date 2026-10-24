# Running the game on PostgreSQL

By default the game keeps everything in files in `data/`. With `STORE=postgres` the same data lives in a PostgreSQL database
instead: the audit ledger, client registry, back-office and admin accounts, player sessions, blocked players, the RTP setting
and the single-writer lock. The game logic is unchanged.

## Try it on your own machine (localhost)

1. Install dependencies once (the `pg` driver is the first npm dependency of the project):

       npm install

2. Create a database and a user (any names; these are examples):

       psql -U postgres -c "CREATE USER horse WITH PASSWORD 'change-me'"
       psql -U postgres -c "CREATE DATABASE horserace OWNER horse"

3. Point the game at it (tables are created automatically on the first start):

       export STORE=postgres
       export PG_URL=postgres://horse:change-me@localhost:5432/horserace

4. Optional: bring over what you already have in `data/` (clients, accounts, ledger). The ledger's hash chain is verified before
   anything is written, and verified again from the database afterwards:

       node scripts/migrate-to-pg.js --dry-run          # shows what would be copied
       node scripts/migrate-to-pg.js                    # copies it (the files are not changed or deleted)

5. Start as usual. The log says `storage: PostgreSQL (N ledger lines loaded)`:

       GAME_MODE=live WALLET=mock ALLOW_MOCK_WALLET=1 node server.js

   The helper scripts use the same two variables, so `node scripts/clients.js add ...` and
   `node scripts/clients.js add-operator ...` then work on the database.

6. Check the ledger at any time:

       node scripts/verify-ledger.js --pg

Back to files: unset `STORE` (the files in `data/` are what you had before the migration).

## What lives where

| Table | Content |
|---|---|
| `ledger` | every event as one line of the hash-chained audit log; append-only (a trigger rejects UPDATE and DELETE) |
| `docs` | `clients.json`, `users.json`, `admins.json`, `sessions.json`, `blocked.json`, `settings.json` (same JSON as the files; secrets stay encrypted with `CLIENTS_KEY`) |
| `instance` | who holds the single-writer lock |

The "only one instance may run the game" rule uses a PostgreSQL advisory lock held by a dedicated connection (the file lease is
not used). A second server started on the same database waits as a standby when `STANDBY=1`, otherwise it refuses to start.
If the connection to PostgreSQL is lost the active server stops itself (fencing), exactly as with the file lease.

## How writes behave

The game keeps its state in memory and sends writes to PostgreSQL in order, in the background (write-behind). If the database is
away they wait and are retried with back-off; `/api` health shows `store.pending` and `store.error`. A clean shutdown (SIGTERM)
waits for them. A hard crash can lose the last few writes that had not been sent yet; the wallet platform stays the source of
truth for money, and a restart replays the ledger and reconciles open rounds as before.

## Tests

`npm test` includes `test/pg.test.js`. It starts a throw-away PostgreSQL cluster when the PostgreSQL 16 binaries are installed, or
uses `PG_TEST_URL=postgres://user:pw@localhost:5432/postgres` (a temporary database is created and dropped). Without either it is skipped.
