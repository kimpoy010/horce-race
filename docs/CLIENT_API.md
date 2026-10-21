# Clients: onboarding and the client API

One game server can serve many platforms ("clients"). All clients share the same race and the same RTP; each client has its own wallet, secrets,
API keys, currency, limits and webhook, and sees only its own players.

## 1. What a client gets

| Item | What it is | Who holds it |
|---|---|---|
| **Client id** | short name in the launch link, e.g. `acme` (lower-case letters, digits, `-`) | both |
| **API key** `hrk_acme_<48 hex>` | the client calls the client API with it (`Authorization: Bearer ...`). Shown once; the game keeps only a hash. Several keys can exist (rotation). | client |
| **Wallet signing secret** | the client's platform verifies the game's signed wallet calls and webhooks with it (see `WALLET_API.md`) | both |
| **Launch link** | `https://GAME_HOST/?client=acme&token=<one-time token>` | client builds it |

## 2. Onboarding a client (operator)

```
# CLIENTS_KEY encrypts the wallet secrets in data/clients.json: set it once in the server's environment (and for the commands below)
export CLIENTS_KEY=$(openssl rand -hex 32)

node scripts/clients.js add acme --name "Acme Casino" --currency PHP \
  --wallet-url https://platform.acme.example/horse-api \
  --webhook-url https://platform.acme.example/horse-events \
  --min-bet 100 --max-bet 100000 --max-round-stake 500000 --daily-loss-limit 0 \
  --reality-check-min 30 --ips 203.0.113.0/24 --return-hosts lobby.acme.example
```

The command prints the **API key** and the generated **wallet signing secret** once. Give both to the client over a safe channel. The running
server picks the change up within seconds. More commands: `list`, `show <id>`, `update <id> ...`, `rotate-key <id> [--grace-hours 24]`,
`revoke-key <id> <keyId>`, `disable <id>` / `enable <id>`, `remove <id> --yes` (see the top of `scripts/clients.js`).

The same actions exist as operator API calls (header `X-Controller-Key`): `GET/POST /api/clients`, `GET/POST /api/clients/<id>`,
`POST /api/clients/<id>/rotate-key` `{graceHours}`, `/revoke-key` `{keyId}`, `/status` `{status: "active"|"disabled"}`, `/delete` `{confirm: "<id>"}`.
Every change is written to the ledger (`client_admin`).

### Client settings

| Field | Meaning |
|---|---|
| `wallet.url`, `wallet.secret`, `wallet.keyId`, `wallet.auth` | where the game calls the client's wallet (HTTPS, plain http only for localhost) and how it signs: see `WALLET_API.md` |
| `webhook.url`, `webhook.secret`, `webhook.events` | the client's webhook (`round.settled`, `big.win`); the secret defaults to the wallet secret |
| `currency` | default currency when the platform's reply has none |
| `limits`, `currencyLimits` | `minBet`, `maxBet`, `maxRoundStake`, `dailyLossLimit`, `decimals` in minor units; the platform's own `/session/validate` reply can still set them per player |
| `realityCheckMinutes`, `bigWinMin` | defaults for this client |
| `allowedIps` | IPv4 addresses or CIDR ranges that may use this client's API key (empty = any). Behind a proxy set `TRUST_PROXY=1`. |
| `returnUrlHosts` | the "back to lobby" link of a player is only shown when its host is in this list |
| `status` | `disabled` ends all its sessions and blocks launches and its API key at once |

Settings are layered: server defaults, the server's currency table, the client's `limits`, the client's `currencyLimits`, then the platform's reply for the player.

## 3. Launching

`https://GAME_HOST/?client=<id>&token=<one-time token>`. The game calls that client's wallet (`/session/validate`, debit, credit, ...). Player ids are
per client: player `p1` at `acme` and `p1` at `zeta` are different players. A player id may contain letters, digits, `_ . @ -` (up to 64 characters).
If there is a single client and no default wallet, `client` may be left out.
Errors on launch: `INVALID_CLIENT`, `CLIENT_DISABLED`, `CLIENT_REQUIRED`, `INVALID_TOKEN`, `INVALID_PLAYER_ID`, `PLAYER_BLOCKED`.

## 4. The client API

All calls need `Authorization: Bearer hrk_...` and (when configured) a request from an allowed IP. Ten wrong keys from one address block it for 5 minutes.
Everything is limited to the client's own players.

| Call | Result |
|---|---|
| `GET /api/client/info` | the client's settings (no secrets) |
| `GET /api/client/report` | bets, staked, paid, RTP, active sessions, pending credits / rollbacks, blocked players, current race |
| `GET /api/client/history?playerId=p1&limit=50` | the player's rounds and bets with the draw proof commit |
| `POST /api/client/players/block` `{playerId}` / `unblock` | self-exclusion: ends the player's sessions and refuses new launches |
| `POST /api/client/players/close-sessions` `{playerId}` | ends the player's sessions |

Errors: `INVALID_API_KEY` (401), `BAD_REQUEST` (400).

## 5. Keys

* **Rotate**: `node scripts/clients.js rotate-key acme --grace-hours 24` creates a new key; the old keys keep working for the grace time so the client can switch
  without downtime. `--grace-hours 0` revokes the old keys at once (use it after a leak).
* **Wallet secret**: to change it, `update <id> --wallet-secret <new>` and give the new secret to the client at the same time (calls signed with the old one are
  rejected by the client as soon as it switches), ideally between races.
* Keys and secrets are never shown again and never leave through the listings. The file `data/clients.json` is owner-only; secrets inside are encrypted with `CLIENTS_KEY`.
  Back the file and `CLIENTS_KEY` up separately.

## 6. Good to know

* **One race for everyone.** All clients' players watch the same race with the same odds and the same RTP setting. The RTP cannot differ per client.
* **Default client.** Without any registry entry the game works as before with the `WALLET_*` settings (the implicit `default` client). Set `WALLET=none` to run
  with registry clients only.
* **Webhooks.** Each client receives `round.settled` for every race (with its own bets, staked and paid; the draw is the same for all) and `big.win` for its players.
  Event ids contain the client id.
* **Back office**: clients also get a web panel with their own logins and roles at `/backoffice`: see `BACKOFFICE.md`.
* **Not built yet**: per-client rate limits.
