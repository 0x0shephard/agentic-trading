// Protocol-wide constants. Decimals are the single most error-prone thing in
// this system, so they live here and are referenced everywhere — never inlined.

/** Sepolia. The process refuses to run on any other chain. */
export const CHAIN_ID = 11155111 as const;

/** Mock USDC (collateral token) is 6 decimals — NOT 18. Used for mint/approve/deposit/balanceOf. */
export const USDC_DECIMALS = 6 as const;

/** The protocol's fixed-point: sizes, prices, margins, PnL are all x18 ("WAD"). */
export const WAD_DECIMALS = 18 as const;
export const WAD = 10n ** 18n;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
