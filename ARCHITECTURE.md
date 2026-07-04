# ByteStrike Agent Simulator — Architecture & Guide

A testnet trading-agent simulator for the ByteStrike GPU-compute perpetual-futures
exchange. It runs a fleet of simulated traders ("agents") against the **live
Sepolia** contracts to generate realistic market structure (open interest,
volume, liquidations) for testing.

- **Language / stack:** TypeScript + [viem](https://viem.sh) (no ethers), `zod`
  for env validation, `pino` for logging, `vitest` for tests, `tsx` to run.
- **Design source:** `../overhaul/AGENTIC_TRADING_ARCHITECTURE.md` (the 8
  archetypes, the OI:Vol:TVL controller, the cost model).

---

## 1. Safety model (read this first)

Every safeguard exists because this talks to a live chain:

| Rail | What it does |
|------|--------------|
| **`DRY_RUN`** (env, default `true`) | When true, nothing is signed or sent — writes are only *simulated* (`eth_call`) and logged. Flip to `false` only for a deliberate live run. |
| **Sepolia-only guard** | `env.ts` refuses to start if `CHAIN_ID` ≠ 11155111; `assertChain()` re-checks the RPC's actual chain id at boot. |
| **Simulate-before-send** | `executeWrite` runs `simulateContract` first. A revert there means the tx is **never sent** (no gas spent). |
| **Gas buffer + affordability pre-flight** | Gas limit = estimate × 1.25 (covers the close's storage-refund shortfall); if a wallet can't afford `gasLimit × maxFeePerGas`, the tx is skipped with a "needs refill" signal instead of crashing. |
| **`KILL_SWITCH`** (env, default `false`) | When true, agent loops stop at the next tick. |
| **LLM key optional** | With no `ANTHROPIC_API_KEY`, the macro agent holds and the supervisor is skipped — the deterministic swarm is unaffected. |

**Golden rule:** validate everything with `DRY_RUN=true` first; flip to `false`
only for the specific run you intend, then flip back.

---

## 2. Repo structure

```
agent/
├── src/
│   ├── config/            # All the knobs and constants (no logic)
│   │   ├── constants.ts      # CHAIN_ID, decimals (USDC=6, WAD=18), ZERO_ADDRESS
│   │   ├── env.ts            # zod-validated env vars + Sepolia guard
│   │   ├── addresses.ts      # deployed contract addresses (ClearingHouse, vault, …)
│   │   ├── markets.ts        # the 5 curated markets (name + bytes32 id) + DEFAULT_MARKET
│   │   ├── archetypes.ts     # the 8 archetype IDs + default params (cadence/size/lev/side)
│   │   └── provisioning.ts   # fleet funding targets (ETH/USDC/collateral, refill thresholds)
│   │
│   ├── chain/             # Everything that touches the blockchain
│   │   ├── abis.ts           # typed `as const` ABI fragments (only what we call)
│   │   ├── clients.ts        # publicClient (reads), walletFor(account), agentAccount(index)
│   │   ├── market.ts         # getMarketConfig / getReserves / getMarkPrice / getIndexPrice / getPosition
│   │   ├── native.ts         # ETH balance + DRY_RUN-guarded ETH transfer
│   │   └── tx.ts             # executeWrite() — THE chokepoint for every write
│   │
│   ├── collateral/collateral.ts   # mint/approve/deposit USDC (6-dp), balances
│   │
│   ├── preview/           # Order math (pure, no chain)
│   │   ├── orderPreview.ts   # BigInt port of the dApp's order math (quoteBuy/quoteSell, …)
│   │   └── sizing.ts         # quoteMarket() + amountLimitWithSlippage()
│   │
│   ├── market/
│   │   ├── snapshot.ts       # MarketSnapshot (mark+index+deviation+reserves) + account state
│   │   └── history.ts        # rolling price history (SMA / returns) for momentum
│   │
│   ├── strategy/          # The brains — one decide() per archetype
│   │   ├── types.ts          # Strategy, StrategyContext, Intent (open/close/hold)
│   │   ├── knobs.ts          # controller-tunable knobs (buildRate, churnRate, …)
│   │   ├── helpers.ts        # baseSizeForNotional, positionNotionalUsd, …
│   │   ├── probe.ts          # validation-only strategy (open↔close)
│   │   ├── registry.ts       # archetype id → Strategy
│   │   └── archetypes/       # hedger, basisArb, momentum, marketMaker, hftTaker, degen, macro
│   │
│   ├── execution/act.ts   # executeIntent() — turns an Intent into a priced, gated tx
│   │
│   ├── runtime/           # The per-agent loop
│   │   ├── rng.ts            # seedable PRNG (deterministic per agent)
│   │   ├── cadence.ts        # Poisson delays + interruptible sleep
│   │   └── agentLoop.ts      # runAgent(): wait → snapshot → decide → act, per tick
│   │
│   ├── orchestrator/      # Running the whole fleet
│   │   ├── assignments.ts    # which wallet runs which archetype
│   │   ├── rateLimiter.ts    # global TPS token bucket
│   │   ├── volumeTracker.ts  # rolling traded-notional (for the controller)
│   │   └── orchestrator.ts   # runOrchestrator(): concurrent loops + controller + supervisor + refills
│   │
│   ├── controller/        # Market-structure controller
│   │   ├── metrics.ts        # measure exchange-wide OI / TVL / Volume
│   │   └── controller.ts     # OI:Vol:TVL = 1:1.20:0.55 → set knobs (deadband, rate-limited)
│   │
│   ├── llm/               # The AI layer (optional — needs ANTHROPIC_API_KEY)
│   │   ├── client.ts         # lazy Anthropic client (null if no key)
│   │   ├── regime.ts         # shared regime state (risk_on/neutral/risk_off) + multipliers
│   │   └── supervisor.ts     # periodic Claude call that sets the regime
│   │
│   ├── observability/     # Reporting & attribution
│   │   ├── labels.ts         # wallet index → readable label (mm-01, hft-02, …)
│   │   ├── attribution.ts    # per-agent session stats (trades/volume/gas/reverts/skips)
│   │   └── report.ts         # fleet report: per-agent + per-archetype + exchange vs target
│   │
│   ├── treasury/treasury.ts  # provision() (budget-aware funding) + treasuryStatus()
│   ├── wallet/fleet.ts       # treasury() (index 0) + agentMembers(1..N)
│   ├── logging/logger.ts     # pino logger
│   └── index.ts              # boot/healthcheck (validates markets against chain)
│
├── scripts/               # CLI entrypoints (run via npm run … or npx tsx)
├── .env / .env.example    # configuration (see §6)
├── package.json           # dependencies + npm scripts
└── tsconfig.json          # strict TS config
```

---

## 3. How it works

### System architecture (as built)

```
 scripts/ (CLI):  run-swarm ─▶ runOrchestrator       run-agent ─▶ runAgent
                  provision · treasury · report · flatten · supervisor · diag-*
                                       │
                                       ▼
 ┌───────────────────────────────────────────────────────────────────────┐
 │ ORCHESTRATOR  (orchestrator/orchestrator.ts)                            │
 │                                                                         │
 │ shared state (control loops WRITE, agent loops READ each tick):         │
 │   knobs {buildRate, churnRate, …}        ← controller                   │
 │   regimeState {stance, vol}              ← supervisor                   │
 │   VolumeTracker · Attribution            ← onTrade                      │
 │   TokenBucket (global TPS cap)                                          │
 │                                                                         │
 │ background timers:                                                      │
 │   controller  measureMetrics → stepController → mutate knobs            │
 │   supervisor  summarizeMarkets → Claude → mutate regime      [API key]  │
 │   refill      provision → top up agent ETH / collateral                │
 │   report      buildFleetReport → "fleet report" heartbeat              │
 └───────────────────────────────────────────────────────────────────────┘
                                       │  spawns N concurrent agent loops
                                       ▼
 ┌───────────────────────────────────────────────────────────────────────┐
 │ AGENT LOOP  (runtime/agentLoop.ts)                  × N, one wallet each│
 │   sleep Poisson(rate = base × knob × regime × mult)   [interruptible]   │
 │    → getMarketSnapshot        mark + index + deviation + reserves       │
 │    → getAccountMarketState    own position + margin + collateral        │
 │    → MarketHistory            SMA / returns (for momentum)              │
 │    → strategy.decide(ctx)     registry → archetype  (macro → Claude)    │
 │         → Intent (open / close / hold)                                  │
 │    → gate.acquire()           global TPS token                          │
 │    → executeIntent            price from live reserves + slippage cap   │
 │    → onTrade(event)           → VolumeTracker + Attribution             │
 └───────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
 ┌───────────────────────────────────────────────────────────────────────┐
 │ CHAIN LAYER  (chain/)                                                   │
 │   executeWrite:  simulate → DRY_RUN stop → gas est × 1.25 →             │
 │                  affordability pre-flight → send → verify receipt       │
 │   reads: market (reserves / mark / index / position) · native ETH      │
 │   clients: publicClient (reads)  ·  walletFor(account) (writes)         │
 └───────────────────────────────────────────────────────────────────────┘
                                       │  viem  ·  Sepolia-only guard
                                       ▼
 ┌───────────────────────────────────────────────────────────────────────┐
 │ ByteStrike contracts on Sepolia                                        │
 │   ClearingHouse · CollateralVault · MarketRegistry ·                   │
 │   vAMM (per market) · Oracle · mock USDC                               │
 └───────────────────────────────────────────────────────────────────────┘

 config/  env · addresses · markets · archetypes · provisioning · constants
          (read by every layer)
```

**The core idea:** the control loops (controller, supervisor) and the agent loops
communicate only through **shared mutable state** — `knobs` and `regimeState`.
Controllers *write* them on their own timers; every agent *reads* them on its next
tick (both for its Poisson cadence and inside `decide()`). Nothing calls anything
across loops directly, so agents, controller, and supervisor stay decoupled.

### One agent tick

A single agent tick (`runAgent` in `runtime/agentLoop.ts`):

```
 wait Poisson delay          (cadence.ts — rate = base × knob × regime × multiplier)
   → getMarketSnapshot()     (market/snapshot.ts — mark, index, deviation, reserves)
   → getAccountMarketState() (own position, margin, vault collateral)
   → strategy.decide(ctx)    (strategy/archetypes/* — returns an Intent)
        Intent = { hold } | { open, isLong, size, slippage } | { close, fraction, slippage }
   → executeIntent()         (execution/act.ts — prices from live reserves, applies slippage)
        → executeWrite()     (chain/tx.ts — simulate → DRY_RUN stop → gas buffer → send → verify)
   → onTrade(notional)       (feeds the volume tracker)
```

The **orchestrator** (`orchestrator/orchestrator.ts`) runs one such loop per agent
concurrently, all sharing:
- a **global TPS token bucket** (caps aggregate send rate),
- a **live, mutable `knobs` object** the controller edits in place,
- the **shared `regimeState`** the supervisor edits,
- a periodic **treasury refill** (tops up agent ETH), and
- **graceful shutdown** (duration / Ctrl-C / KILL_SWITCH, via interruptible sleep).

The **controller** (`controller/controller.ts`) runs on its own timer: it measures
exchange-wide OI (on-chain positions × mark), TVL (vault balances), and Volume
(rolling tracker), compares them to the **1 : 1.20 : 0.55** target, and nudges
`buildRate` (drives OI) and `churnRate` (drives Volume) — proportional, with a
±5% deadband and a ≤20%/cycle step cap. Because the knobs are live, agents pick up
the change on their next tick.

The **LLM layer** (optional): the **supervisor** periodically asks Claude for a
market **regime**, which scales overall cadence and macro conviction. The **macro
archetype (#7)** asks Claude for a directional decision, which is **clamped** to
the risk caps and then executed through the exact same gated path as every other
agent — the model can never bypass limits.

---

## 4. The 8 archetypes

Deterministic strategies are pure `(context) → Intent` functions; #7 is LLM-backed.

| # | Archetype | id | Behavior | Cadence |
|---|-----------|-----|----------|---------|
| 1 | Datacenter hedger | `hedger-short` | builds a structural short to target, trims over | slow (~hrs) |
| 2 | Compute buyer | `hedger-long` | builds a structural long to target | slow (~hrs) |
| 3 | Basis arb | `basis-arb` | fades mark-vs-index deviation, unwinds on convergence | event (~10 min) |
| 4 | Momentum / CTA | `momentum` | SMA cross; pyramids with trend, cuts on reversal | ~2 min |
| 5 | Market maker | `market-maker` | counter-flow fade, inventory-capped, backs off in stress | ~15 s |
| 6 | Stat-arb / HFT | `hft-taker` | tiny fast round-trips (TPS generator) | ~7.5 s |
| 7 | Macro / directional | `macro` | **LLM** — discretionary conviction, clamped + gated | slow, rare |
| 8 | Overleveraged degen | `degen` | max-lev, holds into liquidation (feedstock) | bursty |

Defaults (size/leverage/cadence/side) live in `config/archetypes.ts` — all
controller-tunable at runtime via knobs.

---

## 5. Commands

Wallet index **0 is the treasury** (funder); indices **1..N are agents**. All
commands respect `DRY_RUN`. Prefix a command with `DRY_RUN=true` to force a safe
run regardless of `.env` (e.g. `DRY_RUN=true npm run swarm 3 20 300`).

### Setup / inspection
```bash
npm install                     # install deps
npm run gen:mnemonic            # generate an HD mnemonic → put in .env as AGENT_MNEMONIC
npm run wallets                 # print derived wallet addresses (index 0 = treasury)
npm run treasury [n]            # read-only balance table for treasury + agents 1..n
npm run typecheck               # tsc --noEmit
npm run test                    # vitest (48 tests)
```

### Funding the fleet
```bash
npm run provision [n]           # budget-aware, idempotent: fund ETH + mint/approve/deposit for agents 1..n
                                # re-run anytime more ETH arrives — only tops up what's missing
```

### Running agents
```bash
npm run agent <archetype> [idx] [ticks]   # run ONE agent a few ticks (validation)
  #  e.g. DRY_RUN=true npm run agent market-maker 1 3
  #       npm run agent probe 1 2          # probe = open↔close smoke test
npm run swarm [count] [durSec] [rateMult] [ctrlSec] [reportSec]   # run the whole fleet
  #  DRY_RUN=true npm run swarm 3 20 300 5 5  # 3 agents, 20s, 300× cadence, controller + report every 5s
  #  npm run swarm 3 0                        # 3 agents, run live until Ctrl-C
```

### Observability
```bash
npm run report [n]              # read-only fleet report: per-agent + per-archetype OI/PnL + exchange vs target ratio
# A running `npm run swarm` also logs a "fleet report" heartbeat every 60s (arg 6 tunes the interval),
# and per-agent logs use readable labels (mm-01, basis-01, …) instead of raw addresses.
```

### LLM layer (needs ANTHROPIC_API_KEY)
```bash
npm run supervisor              # run one regime cycle and print the regime
# (the orchestrator also auto-runs the supervisor ~every 20 min when a key is present)
```

### Cleanup & diagnostics
```bash
npm run flatten [start] [end]   # close all open positions for wallets start..end
  #  npm run flatten 1 3         # flatten the whole fleet
npx tsx scripts/diag-snapshot.ts   # mark vs index (and deviation) per market
npx tsx scripts/diag-gas.ts        # current Sepolia gas + per-trade cost
npx tsx scripts/diag-close.ts <idx>          # why a close would revert (read-only)
npx tsx scripts/diag-tx.ts <txHash>          # replay a mined tx to recover its revert reason
```

---

## 6. Configuration

### `.env` (see `.env.example`)
| Var | Default | Purpose |
|-----|---------|---------|
| `AGENT_MNEMONIC` | — | HD mnemonic; wallet 0 = treasury, 1..N = agents. **Required.** |
| `SEPOLIA_RPC_URL` | public node | Sepolia JSON-RPC endpoint |
| `CHAIN_ID` | 11155111 | must be Sepolia or the process refuses to start |
| `DRY_RUN` | `true` | `false` = actually send transactions |
| `KILL_SWITCH` | `false` | `true` = stop agent loops |
| `ANTHROPIC_API_KEY` | — | enables the macro agent + supervisor |
| `LLM_MODEL` | `claude-opus-4-8` | LLM used by macro/supervisor (`claude-haiku-4-5` for the cheap tier) |
| `LOG_LEVEL` | `info` | pino level |

### Tuning files (code, not env)
- **`config/provisioning.ts`** — per-agent ETH target, treasury reserve, USDC/collateral targets, ETH refill threshold, default fleet size.
- **`config/archetypes.ts`** — each archetype's base cadence, clip/target notional, leverage, side bias, slippage.
- **`config/markets.ts`** — which markets to trade (`DEFAULT_MARKET` = H100).
- **`controller/controller.ts`** (`DEFAULT_CONTROLLER`) — the OI anchor, the ratios, deadband, step cap.
- **`orchestrator/assignments.ts`** — the archetype mix assigned across wallets.

---

## 7. Typical workflows

**First-time setup**
```bash
npm install
npm run gen:mnemonic        # paste output into .env as AGENT_MNEMONIC
npm run wallets             # note wallet 0 (treasury) — send it Sepolia ETH from a faucet
```

**Validate everything (no spend)**
```bash
npm run typecheck && npm run test
DRY_RUN=true npm run swarm 3 20 300 5     # watch the swarm + controller in dry-run
```

**Go live (a deliberate run)**
```bash
npm run provision 3        # fund the fleet (needs treasury ETH)  [set DRY_RUN=false]
npm run treasury 3         # confirm agents funded + collateralized
npm run swarm 3 0          # run until Ctrl-C
# … Ctrl-C to stop …
npm run flatten 1 3        # close everything
# set DRY_RUN=true again in .env
```

---

## 8. Extending — add a new deterministic archetype

1. Add its id + default params to `config/archetypes.ts` (`ArchetypeId`, `DEFAULT_ARCHETYPES`).
2. Write `src/strategy/archetypes/<name>.ts` exporting a `Strategy` (`decide(ctx) → Intent`).
3. Register it in `src/strategy/registry.ts`.
4. Add it to the composition in `orchestrator/assignments.ts` (optional).
5. Add unit tests in `src/strategy/strategies.test.ts` (synthetic context → expected intent).

The runtime, executor, gas handling, controller, and orchestrator require **no
changes** — they operate on the `Strategy`/`Intent` interface.
