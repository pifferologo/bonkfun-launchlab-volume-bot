# Bonkfun Volume Bot – Raydium LaunchLab Volume Bot for Solana

A **Bonkfun volume bot** for Solana that automates volume on Raydium LaunchLab (Bonk.fun–style token launches). Create multiple wallets, airdrop SOL, run repeated buy/sell cycles on a LaunchLab pool, then retrieve SOL and close token accounts. Optimized for natural-looking volume with configurable amounts, delays, and Jito bundle support.

---

## Project Architecture

### High-level flow

1. **Entry** – `main.ts` starts the CLI and shows the menu (AUTO Random Buyers / Retrieve SOL).
2. **Buy cycle** – `bot.ts` (`extender`) creates keypairs, airdrops SOL, builds buy transactions (create ATA, wrap SOL, swap via Raydium LaunchLab), and can send them in a Jito bundle or sequentially.
3. **Sell / cleanup** – Same cycle picks older keypairs (by file age), sells tokens, withdraws SOL, and closes ATAs via `retrieve.ts` (`closeSpecificAcc`).
4. **Retrieve mode** – From the menu, “Retrieve SOL ALL WALLETS” runs `retrieve.ts` (`closeAcc`) to sell and close all keypairs for a given token mint.

### Directory layout

```
bonkfun-launchlab-volume-bot/
├── main.ts              # CLI entry, menu, runs extender or closeAcc
├── config.ts            # Loads RPC, SECRET_KEY, API_KEY from .env; connection, wallet, tip account
├── bot.ts               # Buy/sell cycles: keypair creation, executeSwaps(), Jito bundle/sequential send
├── retrieve.ts          # closeAcc (all wallets for a mint), closeSpecificAcc (sell + withdraw + close ATA)
├── utils.ts             # Raydium SDK init, buy(), sell(), getSwapInstruction, burnAccount
├── clients/
│   ├── jito.ts          # Jito block engine / searcher client for bundle submission
│   ├── config.ts        # Jito/convict config (block engine URLs, geyser, etc.)
│   ├── constants.ts     # Raydium/LaunchLab addresses and discriminators
│   ├── LookupTableProvider.ts
│   └── encrypt/         # Parsing and helpers for pool/platform accounts
├── .env.example
├── package.json
└── tsconfig.json
```

### Main components

| Component      | Role |
|----------------|------|
| **main.ts**    | Entry point; menu: (1) AUTO Random Buyers, (2) Retrieve SOL all wallets. |
| **config.ts**  | Reads `RPC`, `SECRET_KEY`, `API_KEY`; exports `connection`, `wallet`, `tipAcct`. |
| **bot.ts**     | `extender()`: per-cycle creates N keypairs, airdrops SOL, builds buy txns (WSOL + swap), then selects old keypairs to sell and calls `closeSpecificAcc`. Uses `utils` buy/swap and optional Jito `sendBundle`. |
| **retrieve.ts**| `closeAcc()`: interactive “retrieve all SOL” for one token mint. `closeSpecificAcc()`: sell token, withdraw SOL, close ATA for a list of keypairs. |
| **utils.ts**   | Raydium SDK init, LaunchLab `buy()`/`sell()`, `getSwapInstruction`, token burn/close helpers. |
| **clients/**   | Jito (bundles), lookup tables, and encrypted/pool parsing for LaunchLab. |

---

## How to Run This Project

### 1. Clone the repository

```bash
git clone https://github.com/m4rcu5o/Bonk-dot-fun-Launch-Lab-Volume-Bot.git
cd Bonk-dot-fun-Launch-Lab-Volume-Bot
```

(If your repo URL differs, use your actual clone URL and folder name.)

### 2. Install dependencies

```bash
yarn install
```

### 3. Configure environment

Copy the example env and set your values:

```bash
cp .env.example .env
```

Edit `.env`:

```env
RPC=<your_solana_rpc_url>
SECRET_KEY=<base58_wallet_secret_key>
API_KEY=<your_api_key>
DEBUG=true
```

- **RPC** – Solana RPC endpoint (e.g. Helius, QuickNode). A paid RPC is recommended for mainnet.
- **SECRET_KEY** – Base58-encoded keypair used as the funder wallet (airdrops and fees).
- **API_KEY** – Used by the app (e.g. for Jito or other services as configured).
- **DEBUG** – Set to `true` to enable simulation logging and extra checks.

Optional (for Jito bundles): configure `clients/config.ts` / env (e.g. `BLOCK_ENGINE_URLS`, `GEYSER_URL`, `GEYSER_ACCESS_TOKEN`) as needed.

### 4. Run the bot

From the project root:

```bash
yarn start
```

This runs `ts-node main.ts`. You will see:

- **Menu**
  - `1` – **AUTO Random Buyers**: run the volume flow (token mint, Jito tip, min/max buy, min/max sell, wallets per cycle, delay, number of cycles).
  - `2` – **Retrieve SOL ALL WALLETS**: enter a token mint and delay to sell and retrieve SOL from all stored keypairs for that mint.
  - `exit` – quit.

Keypairs created during “AUTO Random Buyers” are stored under `./src/keypairs/<token_mint>/` and are used for sell/retrieve in later cycles or in option 2.

### 5. Run with a config file (optional)

You can run the extender with a JSON config instead of prompts:

```bash
node -r ts-node/register main.ts -c path/to/config.json
```

Example `config.json` shape (adjust to match what `extender()` expects):

```json
{
  "basemint": "<token_mint_public_key>",
  "minAndMaxBuy": "0.01 0.05",
  "minAndMaxSell": "0.01 0.05",
  "minAndMaxwalletNumber": "2 5",
  "cycles": 50,
  "delay": "10 30",
  "jitoTipAmt": "0.01"
}
```

---

## Features

- Create multiple wallets and airdrop SOL automatically.
- Buy random amounts on a chosen LaunchLab (Bonk.fun–style) pool.
- Steadily sell from older wallets, withdraw SOL, and close ATAs.
- Configurable buy/sell ranges, delays, and wallets per cycle.
- Optional Jito bundle submission for buy transactions.
- Auto-logs and volume-oriented flow for launch campaigns.

---

## Author & Contact

- **Author:** microRustyme  
- **Telegram:** [@microRustyme](https://t.me/microRustyme)

---

## Links

- **Buy example (Solscan):**  
  [Transaction link](https://solscan.io/tx/3ApapK8494RxZtZwaPEUeSKfzQVQ6GqPz5MD8uSNT3Nhj2jQZb4zDgcjuK4H3XttYJM2wocCKQD3UV7qv2BiRTK1)
- **Sell example (Solscan):**  
  [Transaction link](https://solscan.io/tx/4DhpWBz222n3s6KZZXbesx6sCrc4fMnsGq6aZ2Wk7iWxJEsqGpCAWcMSfYbG8od97U5eezwGVsXGs4Lv4w8YH91V)

---

*Bonkfun volume bot · Raydium LaunchLab · Solana*
