// Minimal, exact ABI fragments for the functions the agent uses. Signatures were
// extracted directly from overhaul/src/contracts/abis/*.json — keep them in sync.
// Using `as const` so viem fully infers argument/return types.

export const clearingHouseAbi = [
  {
    type: "function",
    name: "openPosition",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "isLong", type: "bool" },
      { name: "size", type: "uint128" },
      { name: "amountLimit", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "closePosition",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "size", type: "uint128" },
      { name: "amountLimit", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "addMargin",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "removeMargin",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    // Collateral in/out goes through the ClearingHouse (the vault's own deposit is
    // restricted to the CH). `amount` is in the TOKEN's decimals (USDC = 6dp).
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getPosition",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "marketId", type: "bytes32" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "size", type: "int256" },
          { name: "margin", type: "uint256" },
          { name: "entryPriceX18", type: "uint256" },
          { name: "lastFundingPayIndex", type: "uint256" },
          { name: "lastFundingReceiveIndex", type: "uint256" },
          { name: "realizedPnL", type: "int256" },
        ],
      },
    ],
  },
] as const;

export const collateralVaultAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getTokenValueX18",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const marketRegistryAbi = [
  {
    type: "function",
    name: "getMarket",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "vamm", type: "address" },
          { name: "feeBps", type: "uint16" },
          { name: "paused", type: "bool" },
          { name: "oracle", type: "address" },
          { name: "feeRouter", type: "address" },
          { name: "insuranceFund", type: "address" },
          { name: "baseAsset", type: "address" },
          { name: "quoteToken", type: "address" },
          { name: "baseUnit", type: "uint256" },
        ],
      },
    ],
  },
] as const;

export const vammAbi = [
  {
    type: "function",
    name: "getMarkPrice",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getReserves",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "", type: "uint256" },
      { name: "", type: "uint256" },
    ],
  },
] as const;

export const oracleAbi = [
  {
    type: "function",
    name: "getPrice",
    stateMutability: "view",
    inputs: [{ name: "_tokenSymbol", type: "string" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// mock USDC = standard ERC-20 + a public mint(to, amount). amount is in 6-decimal units.
export const erc20Abi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;
