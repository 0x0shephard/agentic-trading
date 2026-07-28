// Admin-action alerting.
//
// Read-only: the audited contracts already emit an event on every privileged
// action, so we watch for those and post to Slack. Nothing on-chain is modified.
//
// Two layers:
//   1. EVENT WATCH   decodes the specific admin actions (pause, param change,
//      fund movement, ownership, upgrade, oracle/feed change, role change) with
//      full context. Sender-agnostic, so it also catches a compromised key.
//   2. CATCH-ALL     scans recent blocks for admin-key transactions. Known
//      operational oracle updates and agent funding are logged quietly; every
//      other call or transfer is alerted with a transaction link. Hashes already
//      covered by a decoded event alert are not repeated.
import { formatEther, formatUnits, parseAbiItem, toFunctionSelector } from "viem";
import type { Address, Hex, PublicClient } from "viem";
import { CONTRACTS } from "../../config/addresses";
import { logger } from "../../logging/logger";
import { sendAlert } from "./slack";
import type { Severity, AlertMessage } from "./slack";

const COLLATERAL_ORACLE: Address = "0x27F4970bd037c09440823755657c5fcF107532ae";
const EXPLORER_TX = "https://sepolia.etherscan.io/tx/";

// Public RPCs cap eth_getLogs block ranges (publicnode rejects wide ranges with
// "Invalid parameters"), so scan in chunks. In steady state the poll window is a
// few blocks and this is a single chunk.
const MAX_LOG_RANGE = 400n;
// Upper bound on the per-block transaction scan (layer 2). The steady-state
// window is tiny; this guards against a one-off large gap turning into thousands
// of getBlock calls. Beyond it we still run the event watch, just not the scan.
const MAX_TX_SCAN = 150n;
const ROUTINE_CU_ORACLE_SELECTORS = new Set<string>([
  toFunctionSelector("commitPrice(bytes32,bytes32)"),
  toFunctionSelector("updatePrices(bytes32,uint256,bytes32)"),
]);

interface AdminTransaction {
  hash: Hex;
  from: Address;
  to: Address | null;
  input: Hex;
  value: bigint;
}

export type RoutineAdminTransaction = "oracle-price-publication" | "agent-eth-funding";

/** Return the recognized operational purpose, or undefined for a tx that needs review. */
export function classifyRoutineAdminTransaction(
  tx: Pick<AdminTransaction, "from" | "to" | "input" | "value">,
  routineRecipients: ReadonlySet<string> = new Set(),
): RoutineAdminTransaction | undefined {
  const to = tx.to?.toLowerCase();
  const selector = tx.input.slice(0, 10).toLowerCase();

  if (
    to === CONTRACTS.cuOracle.toLowerCase()
    && tx.value === 0n
    && ROUTINE_CU_ORACLE_SELECTORS.has(selector)
  ) {
    return "oracle-price-publication";
  }

  if (
    to
    && to !== tx.from.toLowerCase()
    && tx.input === "0x"
    && tx.value > 0n
    && routineRecipients.has(to)
  ) {
    return "agent-eth-funding";
  }

  return undefined;
}

export async function getLogsChunked(
  pc: PublicClient, address: Address, event: AdminEventDef["event"], from: bigint, to: bigint,
): Promise<{ transactionHash: Hex; logIndex: number; blockNumber: bigint; args: Record<string, unknown> }[]> {
  const out: { transactionHash: Hex; logIndex: number; blockNumber: bigint; args: Record<string, unknown> }[] = [];
  for (let start = from; start <= to; start += MAX_LOG_RANGE) {
    const end = start + MAX_LOG_RANGE - 1n > to ? to : start + MAX_LOG_RANGE - 1n;
    const logs = await pc.getLogs({ address, event: event as never, fromBlock: start, toBlock: end });
    out.push(...(logs as never[]));
  }
  return out;
}

// Admin addresses for the catch-all. All Ownable contracts and both role-based
// contracts resolve to the treasury/deployer key; env can add more.
export function adminAddresses(): Address[] {
  const extra = (process.env.ADMIN_WATCH_ADDRESSES ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^0x[0-9a-f]{40}$/.test(s)) as Address[];
  return [...new Set([CONTRACTS.treasury.toLowerCase() as Address, ...extra])];
}

export interface AdminEventDef {
  contract: Address;
  label: string; // contract name for the alert
  event: ReturnType<typeof parseAbiItem>;
  severity: Severity;
  title: string;
  describe: (args: Record<string, unknown>) => string;
}

const bps = (v: unknown) => `${Number(v ?? 0)} bps`;
const shortMkt = (v: unknown) => String(v ?? "").slice(0, 12) + "…";
const usdc = (v: unknown) => `${Number(formatUnits((v as bigint) ?? 0n, 6)).toFixed(2)} USDC`;

// The privileged actions worth paging on. Severity: critical for anything that
// changes control, moves funds, upgrades, or halts a market; warning for tuning.
export const ADMIN_EVENTS: AdminEventDef[] = [
  // ── ClearingHouse ──
  { contract: CONTRACTS.clearingHouse, label: "ClearingHouse", severity: "critical", title: "Ownership transferred",
    event: parseAbiItem("event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)"),
    describe: (a) => `ClearingHouse owner ${String(a.previousOwner).slice(0,10)}… -> ${String(a.newOwner).slice(0,10)}…` },
  { contract: CONTRACTS.clearingHouse, label: "ClearingHouse", severity: "critical", title: "Contract upgraded",
    event: parseAbiItem("event Upgraded(address indexed implementation)"),
    describe: (a) => `ClearingHouse implementation set to ${a.implementation}` },
  { contract: CONTRACTS.clearingHouse, label: "ClearingHouse", severity: "critical", title: "Vault changed",
    event: parseAbiItem("event VaultUpdated(address indexed oldVault, address indexed newVault)"),
    describe: (a) => `Collateral vault ${String(a.oldVault).slice(0,10)}… -> ${String(a.newVault).slice(0,10)}…` },
  { contract: CONTRACTS.clearingHouse, label: "ClearingHouse", severity: "warning", title: "Risk parameters changed",
    event: parseAbiItem("event RiskParamsSet(bytes32 indexed marketId, uint256 imrBps, uint256 mmrBps, uint256 liquidationPenaltyBps, uint256 penaltyCap, uint256 maxPositionSize, uint256 minPositionSize)"),
    describe: (a) => `Market ${shortMkt(a.marketId)}: IMR ${bps(a.imrBps)}, MMR ${bps(a.mmrBps)}, penalty ${bps(a.liquidationPenaltyBps)}` },
  { contract: CONTRACTS.clearingHouse, label: "ClearingHouse", severity: "warning", title: "Liquidator whitelist changed",
    event: parseAbiItem("event LiquidatorWhitelistUpdated(address indexed liquidator, bool isWhitelisted)"),
    describe: (a) => `${a.liquidator} ${a.isWhitelisted ? "ADDED to" : "REMOVED from"} liquidator whitelist` },
  // ── MarketRegistry ──
  { contract: CONTRACTS.marketRegistry, label: "MarketRegistry", severity: "critical", title: "Market pause changed",
    event: parseAbiItem("event MarketPaused(bytes32 indexed marketId, bool paused)"),
    describe: (a) => `Market ${shortMkt(a.marketId)} ${a.paused ? "PAUSED" : "UNPAUSED"}` },
  { contract: CONTRACTS.marketRegistry, label: "MarketRegistry", severity: "critical", title: "Admin role granted",
    event: parseAbiItem("event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)"),
    describe: (a) => `Role ${shortMkt(a.role)} granted to ${a.account} by ${String(a.sender).slice(0,10)}…` },
  { contract: CONTRACTS.marketRegistry, label: "MarketRegistry", severity: "critical", title: "Admin role revoked",
    event: parseAbiItem("event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)"),
    describe: (a) => `Role ${shortMkt(a.role)} revoked from ${a.account}` },
  { contract: CONTRACTS.marketRegistry, label: "MarketRegistry", severity: "warning", title: "Market added",
    event: parseAbiItem("event MarketAdded(bytes32 indexed marketId, address indexed vamm)"),
    describe: (a) => `Market ${shortMkt(a.marketId)} added (vAMM ${String(a.vamm).slice(0,10)}…)` },
  // ── CollateralVault ──
  { contract: CONTRACTS.collateralVault, label: "CollateralVault", severity: "critical", title: "Collateral seized",
    event: parseAbiItem("event Seize(address indexed from, address indexed to, address indexed token, uint256 amount)"),
    describe: (a) => `Seized ${a.amount} from ${String(a.from).slice(0,10)}… -> ${String(a.to).slice(0,10)}…` },
  { contract: CONTRACTS.collateralVault, label: "CollateralVault", severity: "critical", title: "Vault oracle changed",
    event: parseAbiItem("event OracleSet(address indexed oracle)"),
    describe: (a) => `Collateral oracle set to ${a.oracle}` },
  { contract: CONTRACTS.collateralVault, label: "CollateralVault", severity: "warning", title: "Collateral params changed",
    event: parseAbiItem("event CollateralParamsUpdated(address indexed token, uint16 haircutBps, uint16 liqIncentiveBps, uint256 cap, uint256 accountCap, bool enabled, bool depositPaused, bool withdrawPaused, string oracleSymbol)"),
    describe: (a) => `${a.oracleSymbol}: haircut ${bps(a.haircutBps)}, enabled=${a.enabled}, depositPaused=${a.depositPaused}` },
  { contract: CONTRACTS.collateralVault, label: "CollateralVault", severity: "warning", title: "Collateral pause changed",
    event: parseAbiItem("event PauseUpdated(address indexed token, bool depositsPaused, bool withdrawalsPaused)"),
    describe: (a) => `Token ${String(a.token).slice(0,10)}…: deposits paused=${a.depositsPaused}, withdrawals paused=${a.withdrawalsPaused}` },
  // ── InsuranceFund ──
  { contract: CONTRACTS.insuranceFund, label: "InsuranceFund", severity: "critical", title: "Insurance fund payout",
    event: parseAbiItem("event Payout(address indexed to, uint256 amount)"),
    describe: (a) => `Paid ${usdc(a.amount)} to ${String(a.to).slice(0,10)}…` },
  { contract: CONTRACTS.insuranceFund, label: "InsuranceFund", severity: "critical", title: "Token rescued from fund",
    event: parseAbiItem("event TokenRescued(address indexed token, address indexed to, uint256 amount)"),
    describe: (a) => `Rescued ${a.amount} of ${String(a.token).slice(0,10)}… to ${String(a.to).slice(0,10)}…` },
  { contract: CONTRACTS.insuranceFund, label: "InsuranceFund", severity: "warning", title: "Fund authorization changed",
    event: parseAbiItem("event AuthorizedUpdated(address indexed caller, bool allowed)"),
    describe: (a) => `${a.caller} authorization=${a.allowed}` },
  // ── Collateral oracle ──
  { contract: COLLATERAL_ORACLE, label: "Oracle", severity: "critical", title: "Price feed changed",
    event: parseAbiItem("event PriceFeedSet(string indexed tokenSymbol, address indexed priceFeedAddress)"),
    describe: (a) => `Price feed set to ${a.priceFeedAddress}` },
  { contract: COLLATERAL_ORACLE, label: "Oracle", severity: "critical", title: "Sequencer uptime feed changed",
    event: parseAbiItem("event SequencerUptimeFeedSet(address indexed uptimeFeedAddress)"),
    describe: (a) => `Sequencer uptime feed set to ${a.uptimeFeedAddress}` },
];

export interface AdminWatchState {
  cursorBlock: bigint;
  seen: Set<string>; // txHash:logIndex, cross-pass dedup
}

export function newAdminWatchState(fromBlock: bigint): AdminWatchState {
  return { cursorBlock: fromBlock, seen: new Set() };
}

/** One admin-watch pass: decode admin events, then catch any other admin tx.
 *  With `send: false` the alerts are collected and returned but not delivered
 *  (used by the dry-run test). Returns the alerts fired/collected. */
export async function adminWatchPass(
  pc: PublicClient,
  st: AdminWatchState,
  opts: { send?: boolean; routineRecipients?: ReadonlySet<string> } = {},
): Promise<AlertMessage[]> {
  const send = opts.send !== false;
  const out: AlertMessage[] = [];
  const emit = async (m: AlertMessage) => { out.push(m); if (send) await sendAlert(m); };

  const head = await pc.getBlockNumber();
  if (head <= st.cursorBlock) return out;
  const fromBlock = st.cursorBlock + 1n;
  const coveredTx = new Set<string>();

  // ── Layer 1: decoded admin events ──
  for (const def of ADMIN_EVENTS) {
    let logs;
    try {
      logs = await getLogsChunked(pc, def.contract, def.event, fromBlock, head);
    } catch (e) {
      logger.warn({ contract: def.label, title: def.title, err: e instanceof Error ? e.message.split("\n")[0] : String(e) }, "adminwatch: getLogs failed");
      continue;
    }
    for (const l of logs) {
      const key = `${l.transactionHash}:${l.logIndex}`;
      if (st.seen.has(key)) continue;
      st.seen.add(key);
      coveredTx.add(l.transactionHash.toLowerCase());
      await emit({
        severity: def.severity,
        title: `Admin action: ${def.title}`,
        detail: def.describe(l.args),
        fields: { Contract: def.label, Block: Number(l.blockNumber) },
        links: [{ label: "View transaction", url: `${EXPLORER_TX}${l.transactionHash}` }],
      });
    }
  }

  // ── Layer 2: catch-all for any admin-key transaction ──
  // Scan the window's blocks for transactions sent from an admin address. The
  // window is small (a poll's worth of blocks), so this is cheap.
  const admins = new Set(adminAddresses().map((a) => a.toLowerCase()));
  if (admins.size > 0 && head - fromBlock > MAX_TX_SCAN) {
    logger.warn({ from: Number(fromBlock), to: Number(head) }, "adminwatch: window too large for tx catch-all scan; event watch still ran");
  } else if (admins.size > 0) {
    for (let b = fromBlock; b <= head; b++) {
      let block;
      try {
        block = await pc.getBlock({ blockNumber: b, includeTransactions: true });
      } catch { continue; }
      for (const tx of block.transactions as unknown as AdminTransaction[]) {
        if (typeof tx === "string") continue;
        if (!admins.has(tx.from.toLowerCase())) continue;
        const h = tx.hash.toLowerCase();
        if (coveredTx.has(h)) continue; // already alerted with decoded detail
        if (st.seen.has(`tx:${h}`)) continue;
        st.seen.add(`tx:${h}`);
        const routine = classifyRoutineAdminTransaction(tx, opts.routineRecipients);
        if (routine) {
          logger.debug({ txHash: tx.hash, block: Number(b), purpose: routine }, "adminwatch: routine admin transaction");
          continue;
        }
        const selector = tx.input.slice(0, 10);
        await emit({
          severity: "critical",
          title: "Admin key transaction",
          detail: "A transaction was sent from an admin key that did not match a decoded admin action (for example a raw transfer or an untracked call). Review it.",
          fields: {
            From: `${tx.from.slice(0, 10)}…`,
            To: tx.to ? `${tx.to.slice(0, 10)}…` : "contract creation",
            Selector: selector === "0x" ? "raw transfer" : selector,
            "Value (ETH)": formatEther(tx.value),
            Block: Number(b),
          },
          links: [{ label: "View transaction", url: `${EXPLORER_TX}${tx.hash}` }],
        });
      }
    }
  }

  // Bound the dedup set so it cannot grow without limit over a long-running process.
  if (st.seen.size > 5000) st.seen = new Set([...st.seen].slice(-2000));
  st.cursorBlock = head;
  return out;
}
