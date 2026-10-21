# Operator admin console

The page for the people who run the game: **`/admin`**. From here the operator's staff manage the platforms (clients), their API keys, secrets, limits, webhooks and
back-office users, change the RTP, and watch the health of the game. It is separate from the clients' own back office (`/backoffice`, see `BACKOFFICE.md`) and
from the older `/controller` page, which stays for scripts and quick checks (it uses the shared `CONTROLLER_KEY`).

## 1. Accounts and roles

Every person on the operator's team has a personal account (no shared key), stored in `data/admins.json`.

| Role | Can |
|---|---|
| **viewer** | Read everything: overview, clients, their numbers, health, RTP table. Change nothing. |
| **support** | Also suspend / re-enable a client, reset the passwords of a client's back-office users and disable them |
| **admin** | Everything: create, edit and delete clients, API keys, signing secrets, webhooks, add and delete client users, the RTP setting, staff accounts, the audit log |

Create the first account on the server (a temporary password is printed once; the person chooses their own at the first sign-in):

```
node scripts/clients.js add-operator kim --role admin
node scripts/clients.js list-operators
node scripts/clients.js reset-operator-password kim
node scripts/clients.js disable-operator kim     # or enable-operator / remove-operator kim --yes
```

After that an admin creates the other accounts under **Staff**. Passwords (12 characters or more), two-step sign-in (authenticator app), login throttling,
sessions (30 min idle) and CSRF protection work as in the back office (`BACKOFFICE.md` section 3). **Turn on two-step sign-in for every account**: this console
can create clients, keys and change the RTP.

## 2. What is in it

* **Overview**: health (all systems normal / the active alerts), races, bets, staked, paid, gross gaming revenue, actual return, players online, pending wallet items,
  ledger state, payouts versus what the odds predict. The **RTP** setting (88% to 99%, from the next race) with the table of what each odds value returns. A table of all clients with
  their business, people online and wallet health.
* **Clients**: the list, and **Add a client** (id, name, currency, wallet URL, optional signing secret, webhook). The API key and the signing secret are shown once.
* **A client** (click it):
  * numbers: bets, staked, paid, GGR, return, online players, pending wins, blocked players;
  * **Settings**: name, currency, bet limits, daily loss limit, reality check, big-win threshold, allowed addresses for its API, hosts allowed in its lobby link (amounts in the client's currency);
  * **Wallet**: URL, key id, signing mode, 5-minute health (calls, failures, speed), **new signing secret**;
  * **Webhook**: URL, events, new webhook secret;
  * **API keys**: when created and last used, **create a new key** (old ones keep working for the chosen grace time), **revoke** a key;
  * **Back-office users**: the client's staff: add (first administrator), reset password, disable, delete;
  * recent races and the recent activity in its back office;
  * **Suspend / Enable** (ends its sessions, launches and API key stop at once) and **Delete**.
* **Staff**: the operator's own accounts. **Security**: your password and two-step sign-in. **Audit log**: who did what.

## 3. Secrets

API keys, signing secrets and temporary passwords are shown **once**. The game keeps only a hash of API keys and password hashes; signing secrets are encrypted in `data/clients.json`
(with `CLIENTS_KEY`) and never leave the server. Rotating a signing secret means the client's platform must switch to the new one at the same moment, otherwise its wallet rejects the game's calls
(the console warns before you do it; do it between races and agree the time with the client).

## 4. Audit

Every sign-in and change in the console (clients created, edited, suspended, deleted; keys and secrets rotated or revoked; RTP; staff and client users) is written to the tamper-evident
ledger and shown under Audit log. Secret values are never written to it.

## 5. Good to know

* The console works on the **active** instance (on a standby it says so).
* Behind nginx set `TRUST_PROXY=1` so the audit log and login throttling use the real address; restrict `/admin` by IP or VPN if you can (`deploy/nginx.conf` has the operator block you can extend).
* Not built yet: e-mail invitations and resets, single sign-on, per-account IP restrictions, editing the odds table or the global alert settings from the page (those are server settings).
