# Client back office

A web panel at **`/backoffice`** for the platforms (clients) that offer the game. Every person has their own login and role, and sees only their own client's
players. It complements the API in `CLIENT_API.md`; the operator's own panel stays at `/controller`.

## 1. Roles

| Role | Can |
|---|---|
| **viewer** | Dashboard (bets, staked, paid, gross gaming revenue, return to players, players online, pending wallet items), races with draw proofs, players and their bets, CSV exports, own password and two-step sign-in |
| **support** | everything a viewer can, plus block / unblock a player (self-exclusion) and end a player's sessions, each with a reason that goes into the audit log |
| **admin** | everything above, plus: add / disable / delete users and reset their passwords, change roles, rotate the client's API key, read the audit log |

Limits, wallet URL, webhook and IP allow list are shown read-only; only the game operator changes them (they move money).

## 2. Getting started (operator)

1. Register the client (`node scripts/clients.js add ...` or the Clients panel in `/controller`), see `CLIENT_API.md`.
2. Create its first administrator:
   `node scripts/clients.js add-user acme boss --role admin`, or the "Add back-office user" button in `/controller`, or `POST /api/clients/acme/users`.
   A temporary password is printed once. Give it to the person with the client id and the address `https://GAME_HOST/backoffice`.
3. At the first sign-in the person must choose their own password (12 characters or more). From then on the administrator creates the other users in the panel.

Other commands: `list-users`, `reset-password`, `disable-user`, `enable-user`, `remove-user <client> <username> --yes`.

## 3. Security

* **Passwords**: scrypt hashes, 12 characters or more, temporary passwords are random and must be replaced at the first sign-in. A password change signs the user out everywhere else.
* **Two-step sign-in (TOTP)**: any authenticator app (Google / Microsoft Authenticator, 1Password, ...). Set up under Security. A code works once. Recommended for everyone.
  Secrets are encrypted in `data/users.json` with `CLIENTS_KEY`.
* **Login throttling**: 5 wrong passwords lock an account for 10 minutes, 20 failures from one address lock the address. The error message does not say whether the client, user or password was wrong.
* **Sessions**: random token in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` over HTTPS: automatic with `NODE_ENV=production`, or `COOKIE_SECURE=1`), 30 minutes idle and 12 hours absolute.
  The role is checked on every request: disabling a user, changing their role or disabling the client takes effect at once.
* **CSRF and framing**: every change needs the session's CSRF token and a matching `Origin`; the pages cannot be framed and use a strict content security policy.
* **Audit**: sign-ins, locks, password and 2-step changes, user management, player controls, exports and API key rotations are written to the tamper-evident ledger (`bo_action`)
  and shown to administrators under Audit log. Actions of the operator on a client's users are logged too.
* **CSV exports** neutralise text that spreadsheets would run as a formula.
* Put the panel behind HTTPS and set `TRUST_PROXY=1` behind nginx so that throttling and the audit log use the real address (`deploy/nginx.conf` rate-limits `/bo/api/login`).

## 4. Good to know

* The figures cover everything the game server has recorded for the client (rebuilt from the ledger after a restart).
* A client with no registry entry (the implicit `default` client of the `WALLET_*` settings) can have users as client id `default`.
* Not built yet: per-client report exports by date range, e-mail invitations and password reset by e-mail (the operator or an administrator resets passwords), single sign-on, per-user IP restrictions.
