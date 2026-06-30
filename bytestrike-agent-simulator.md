---
name: bytestrike-agent-simulator
description: "The testnet trading-agent simulator being built in agent/ for the ByteStrike GPU-futures exchange — stack, structure, and status."
metadata: 
  node_type: memory
  type: project
  originSessionId: 8c4508fd-d80a-49f9-b8d7-95b25b80d682
---

`agent/` is a standalone TypeScript service (sibling to `overhaul/`, its own git) that runs simulated traders against the live ByteStrike exchange on **Sepolia** for testing/liquidity. Stack: TS + **viem** (no ethers), zod-validated env, pino logging, vitest. Hard safety rails: Sepolia-only chain guard, `DRY_RUN` defaults true (simulate-only). HD wallets derived from one mnemonic via `mnemonicToAccount(index)`.

Design lives in `overhaul/AGENTIC_TRADING_ARCHITECTURE.md`: 8 deterministic archetypes + a market-structure controller targeting **exchange-wide** OI:Volume:TVL = 1 : 1.20 : 0.55 (NOT per-market — user corrected this), with an LLM used ONLY for macro regime + supervisor (Claude Haiku/Sonnet), prompt-cached.

The execution chokepoint is `agent/src/chain/tx.ts` `executeWrite()`: simulate-gate → DRY_RUN stop → estimate-gas(+1.5× buffer) → send → receipt-verify with at-block replay for revert reasons. Sizing is a verbatim BigInt port of the dApp's `orderPreview.js` (13 vitest tests pass).

**Status (as of 2026-07-01):** Phase 1 complete and validated live on Sepolia — full mint→approve→deposit→open→close lifecycle confirmed (wallet index 0 = funded treasury `0xDE2060...C3ab`). Useful scripts: `npm run poc`, `npm run flatten` (close-all), plus read-only `scripts/diag-close.ts` / `scripts/diag-tx.ts`. Next: Phase 2 (wallet/treasury manager, then the 8 archetypes + controller).

See also [[bytestrike-contract-integration-gotchas]].
