# Your own site: player registration, wallet and cashier

Besides platforms that bring their own players, the app can host **your own players**: they register at `/account`, deposit by sending money to your GCash / Maya / bank account, and play with a balance kept in this database. You approve deposits and pay withdrawals by hand in the admin console. It is the built-in client `house`.

## Turn it on

```
php artisan house:setup          # the install script already does this (skip it with --no-house)
```

Then in the admin console (`/admin`, role admin) open **Players & cashier → Payment accounts & limits**, add at least one account players can pay (id, name shown, account name, number) and set the limits. Registration can be closed there with one switch.

Players: `https://your.domain/register` (or the "Sign in or register" link on the game page) → account → **Play now**.

## How the money moves

| Step | Player | You |
|---|---|---|
| Deposit | sends money to your account, enters amount, their name and the payment's reference number | open the **Cashier queue**, check the payment really arrived (same amount, same reference), press **Approve** (or **Reject** with a reason) |
| Play | bets; each bet is taken from the balance, wins are added | nothing (the round loop does it) |
| Withdraw | requests an amount and an account; the amount **leaves the balance at once** | pay it out from your own account, then press **Mark paid** and enter your payout reference; or **Reject** and the amount goes back |

* A payment reference number can be used for one deposit only (the same receipt cannot be submitted twice).
* A player has at most 3 deposits waiting and 1 withdrawal waiting.
* Every movement is one row in `wallet_tx` (cannot be changed afterwards on PostgreSQL) and also a line in the hash-chained ledger; every staff action is in the audit log.
* **Adjust balance** (admin only) needs a reason and is audited. Use it for corrections, not for routine deposits.

## Staff roles

* **support** and **admin**: see players, approve or reject deposits, pay or reject withdrawals, suspend a player, reset a player's password.
* **admin** only: payment accounts and limits, balance adjustments.
* Keep two people in the loop for large amounts if you can: the console does not enforce it.

## Before you take real money from the public

This is the cashier and the accounts. It is **not** a compliance solution. Please check these yourself:

* **Licence**: operating a gambling site for real money needs a licence in most countries (in the Philippines, PAGCOR or a licensed operator). Do not go live without one.
* **Checking players**: nothing here verifies age or identity beyond a tick box, and mobile numbers are not verified by SMS. Add ID checks (KYC) before paying out, and compare the name on a withdrawal account with the player's.
* **Fraud and money laundering**: watch for players who deposit and withdraw with little play, for several accounts from one address (the sign-up address is shown in the player's details), and for deposits reported with reused or invented references. Always check the real payment before you approve.
* **Responsible gambling**: there are no per-player deposit limits or self-exclusion yet. `HORSE_DAILY_LOSS_LIMIT` (per day, centavos) and `HORSE_REALITY_CHECK_MIN` (reminder in minutes) in `.env` apply to every player. Suspending a player in the console stops them at once.
* **Terms and privacy**: the registration page only has a tick box. Publish your own terms, privacy policy and contact details.
* **Not built yet**: automatic payment gateways, SMS or e-mail codes, forgotten-password by the player (staff reset it), bonuses, ID upload.

## Safety of the money

* The balances are real liabilities: **back up the database** every night and test a restore (`php artisan ledger verify` should still say the chain is intact).
* Reconcile once a day: *deposits approved − withdrawals paid − balances held − what the players lost* should match what is in your accounts. The console's summary cards show deposited, paid out and balances held.
* Keep `HORSE_CLIENTS_KEY` and `.env` safe, and restrict `/controller`, `/metrics` and, if you can, `/admin` to your own IPs (see DEPLOYMENT.md).
