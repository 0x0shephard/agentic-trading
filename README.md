# ByteStrike Trading Agents (testnet)

Headless trading-agent simulator for the ByteStrike GPU-futures exchange on **Sepolia**.
Design docs live in `../overhaul/AGENTIC_TRADING_ARCHITECTURE.md` and `../overhaul/TRADING_AGENTS_PLAN.md`.

> **Safety:** testnet only. The process refuses to run on any chain other than Sepolia (`CHAIN_ID 11155111`), and defaults to `DRY_RUN=true`. Never put a mainnet key in `.env`.

## How it trades
Agents call the on-chain `ClearingHouse` directly (viem). No browser, no app API. Activity is captured automatically by the canonical indexer → `canonical_pnl_events` → the `/admin` dashboard.

## Setup
```bash
cp .env.example .env      # fill SEPOLIA_RPC_URL (and AGENT_MNEMONIC when ready)
npm install
npm run typecheck         # verify it compiles
npm run dev               # boot: validates chain + every configured market on-chain
```

## Status
**Phase 0 — foundation.** Read-only: config, chain clients, typed ABIs, hard testnet guard, and a boot-time validator that checks every market in `src/config/markets.ts` against the on-chain `MarketRegistry`. No signing/trading yet.

## Layout
```
src/
  config/    env (validated), constants (decimals), addresses, markets
  chain/     typed ABIs, viem public/wallet clients, testnet guard
  logging/   pino logger
  index.ts   foundation boot / healthcheck
```
