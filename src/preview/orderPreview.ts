// Faithful BigInt port of overhaul/src/utils/orderPreview.js — the exact vAMM
// quote + margin math the dApp uses. Keep logic character-identical; only types
// were added. This is the single most precision-critical module: every value is
// x18 fixed point, fees are in bps. Do not "simplify" the arithmetic.

const WAD = 10n ** 18n;
const BPS_DENOMINATOR = 10000n;
export const MARGIN_TOP_UP_DUST_X18 = 10n ** 12n;

export interface QuoteResult {
  actualBase: bigint;
  quoteAmount: bigint;
  avgPrice: bigint;
  postTradeMark: bigint;
}

export interface BuildOpenOrderPreviewParams {
  isLong: boolean;
  sizeX18: bigint;
  limitPriceX18?: bigint;
  reserveBase: bigint;
  reserveQuote: bigint;
  minReserveBase?: bigint;
  minReserveQuote?: bigint;
  feeBps?: bigint;
  imrBps: bigint;
  mmrBps: bigint;
  oraclePrice: bigint;
  quoteFreeCollateral?: bigint;
  minPositionSize?: bigint;
  maxPositionSize?: bigint;
  existingSizeX18?: bigint;
  existingMarginX18?: bigint;
  existingEntryPriceX18?: bigint;
  targetLeverageX18?: bigint;
}

export interface OrderPreview {
  ok: boolean;
  reason: string | null;
  actualBase: bigint;
  quoteAmount: bigint;
  avgPrice: bigint;
  postTradeMark: bigint;
  notional: bigint;
  fee: bigint;
  initialMargin: bigint;
  automaticMargin: bigint;
  marginReleased: bigint;
  projectedMargin: bigint;
  targetMargin: bigint;
  finalMargin: bigint;
  displayNotional: bigint;
  displayLeverageX18: bigint;
  extraMargin: bigint;
  maintenanceMargin: bigint;
  riskNotional: bigint;
  resultingRiskNotional: bigint;
  resultingSize: bigint;
  resultingEntryPrice: bigint;
  totalRequired: bigint;
  effectiveLeverageX18: bigint;
  liqPrice: bigint;
  amountLimit: bigint;
}

export const ZERO_PREVIEW: OrderPreview = {
  ok: false,
  reason: "Enter a size",
  actualBase: 0n,
  quoteAmount: 0n,
  avgPrice: 0n,
  postTradeMark: 0n,
  notional: 0n,
  fee: 0n,
  initialMargin: 0n,
  automaticMargin: 0n,
  marginReleased: 0n,
  projectedMargin: 0n,
  targetMargin: 0n,
  finalMargin: 0n,
  displayNotional: 0n,
  displayLeverageX18: 0n,
  extraMargin: 0n,
  maintenanceMargin: 0n,
  riskNotional: 0n,
  resultingRiskNotional: 0n,
  resultingSize: 0n,
  resultingEntryPrice: 0n,
  totalRequired: 0n,
  effectiveLeverageX18: 0n,
  liqPrice: 0n,
  amountLimit: 0n,
};

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("division by zero");
  return (a * b) / denominator;
}

function mulDivRoundUp(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("division by zero");
  if (a === 0n || b === 0n) return 0n;
  return (a * b + denominator - 1n) / denominator;
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function int256Difference(a: bigint, b: bigint): bigint {
  return (a ?? 0n) - (b ?? 0n);
}

export function calculateTargetMargin({
  sizeX18,
  riskPriceX18,
  targetLeverageX18,
}: {
  sizeX18: bigint;
  riskPriceX18: bigint;
  targetLeverageX18: bigint;
}): bigint {
  const absoluteSize = abs(sizeX18 || 0n);
  if (absoluteSize === 0n || !riskPriceX18 || !targetLeverageX18) return 0n;
  const riskNotional = mulDivRoundUp(absoluteSize, riskPriceX18, WAD);
  return mulDivRoundUp(riskNotional, WAD, targetLeverageX18);
}

export function calculateLeverageX18({
  sizeX18,
  marginX18,
  riskPriceX18,
}: {
  sizeX18: bigint;
  marginX18: bigint;
  riskPriceX18: bigint;
}): bigint {
  const absoluteSize = abs(sizeX18 || 0n);
  if (absoluteSize === 0n || !marginX18 || !riskPriceX18) return 0n;
  const notional = mulDivRoundUp(absoluteSize, riskPriceX18, WAD);
  return mulDiv(notional, WAD, marginX18);
}

export function estimateLiquidationPrice({
  sizeX18,
  entryPriceX18,
  marginX18,
  mmrBps,
}: {
  sizeX18: bigint;
  entryPriceX18: bigint;
  marginX18: bigint;
  mmrBps: bigint;
}): bigint {
  const absoluteSize = abs(sizeX18 || 0n);
  if (absoluteSize === 0n || !entryPriceX18 || !marginX18) return 0n;

  const entryNotional = mulDiv(absoluteSize, entryPriceX18, WAD);
  const maintenanceBps = mmrBps || 0n;
  if (sizeX18 > 0n) {
    if (marginX18 >= entryNotional || maintenanceBps >= BPS_DENOMINATOR) return 0n;
    return mulDivRoundUp(
      (entryNotional - marginX18) * WAD,
      BPS_DENOMINATOR,
      absoluteSize * (BPS_DENOMINATOR - maintenanceBps),
    );
  }

  return mulDivRoundUp(
    (entryNotional + marginX18) * WAD,
    BPS_DENOMINATOR,
    absoluteSize * (BPS_DENOMINATOR + maintenanceBps),
  );
}

interface ProjectionResult {
  resultingSize: bigint;
  resultingEntryPrice: bigint;
  projectedMargin: bigint;
  automaticMargin: bigint;
  marginReleased: bigint;
  realizedPnl: bigint;
}

export function projectPositionAfterTrade({
  existingSizeX18 = 0n,
  existingMarginX18 = 0n,
  existingEntryPriceX18 = 0n,
  signedBaseDeltaX18,
  executionPriceX18,
  riskPriceX18,
  imrBps,
}: {
  existingSizeX18?: bigint;
  existingMarginX18?: bigint;
  existingEntryPriceX18?: bigint;
  signedBaseDeltaX18: bigint;
  executionPriceX18: bigint;
  riskPriceX18: bigint;
  imrBps: bigint;
}): ProjectionResult {
  const oldSize = existingSizeX18 || 0n;
  const delta = signedBaseDeltaX18 || 0n;
  const nextSize = oldSize + delta;
  const oldAbs = abs(oldSize);
  const deltaAbs = abs(delta);
  const nextAbs = abs(nextSize);
  const sameDirection =
    oldSize === 0n || (oldSize > 0n && delta > 0n) || (oldSize < 0n && delta < 0n);

  let realizedPnl = 0n;
  let nextEntryPrice = existingEntryPriceX18 || 0n;
  if (oldSize === 0n) {
    nextEntryPrice = executionPriceX18;
  } else if (sameDirection) {
    nextEntryPrice =
      nextAbs > 0n ? (oldAbs * existingEntryPriceX18 + deltaAbs * executionPriceX18) / nextAbs : 0n;
  } else {
    const reduceAmount = deltaAbs <= oldAbs ? deltaAbs : oldAbs;
    realizedPnl =
      oldSize > 0n
        ? mulDiv(int256Difference(executionPriceX18, existingEntryPriceX18), reduceAmount, WAD)
        : mulDiv(int256Difference(existingEntryPriceX18, executionPriceX18), reduceAmount, WAD);
    if (nextSize === 0n) nextEntryPrice = 0n;
    else if ((oldSize > 0n && nextSize < 0n) || (oldSize < 0n && nextSize > 0n))
      nextEntryPrice = executionPriceX18;
  }

  let marginAfterPnl = existingMarginX18 || 0n;
  if (realizedPnl >= 0n) marginAfterPnl += realizedPnl;
  else marginAfterPnl = -realizedPnl >= marginAfterPnl ? 0n : marginAfterPnl + realizedPnl;

  let automaticMargin = 0n;
  let marginReleased = 0n;
  let projectedMargin = marginAfterPnl;
  if (sameDirection) {
    const tradeRiskNotional = mulDiv(deltaAbs, riskPriceX18, WAD);
    automaticMargin = mulDiv(tradeRiskNotional, imrBps || 0n, BPS_DENOMINATOR);
    projectedMargin += automaticMargin;
  } else if (oldAbs > 0n) {
    const reduceAmount = deltaAbs <= oldAbs ? deltaAbs : oldAbs;
    marginReleased = mulDiv(marginAfterPnl, reduceAmount, oldAbs);
    projectedMargin -= marginReleased;
    if (deltaAbs > oldAbs) {
      const openAmount = deltaAbs - oldAbs;
      const openRiskNotional = mulDiv(openAmount, riskPriceX18, WAD);
      automaticMargin = mulDiv(openRiskNotional, imrBps || 0n, BPS_DENOMINATOR);
      projectedMargin += automaticMargin;
    }
  }

  return {
    resultingSize: nextSize,
    resultingEntryPrice: nextEntryPrice,
    projectedMargin,
    automaticMargin,
    marginReleased,
    realizedPnl,
  };
}

function clampBuyBaseAmount(baseAmount: bigint, reserveBase: bigint, minReserveBase: bigint): bigint {
  if (baseAmount >= reserveBase) throw new Error("insufficient X");
  if (minReserveBase > 0n) {
    const available = reserveBase > minReserveBase ? reserveBase - minReserveBase : 0n;
    if (available <= 0n) throw new Error("Reserve base depleted");
    return baseAmount > available ? available : baseAmount;
  }
  return baseAmount;
}

export function quoteBuy({
  baseAmount,
  reserveBase,
  reserveQuote,
  minReserveBase,
  feeBps,
}: {
  baseAmount: bigint;
  reserveBase: bigint;
  reserveQuote: bigint;
  minReserveBase: bigint;
  feeBps: bigint;
}): QuoteResult {
  const actualBase = clampBuyBaseAmount(baseAmount, reserveBase, minReserveBase);
  const inWithFeeScaled = mulDivRoundUp(
    actualBase,
    reserveQuote * BPS_DENOMINATOR,
    reserveBase - actualBase,
  );
  const grossQuoteIn = mulDivRoundUp(inWithFeeScaled, 1n, BPS_DENOMINATOR - feeBps);
  const avgPrice = mulDivRoundUp(grossQuoteIn, WAD, actualBase);
  const postReserveBase = reserveBase - actualBase;
  const postReserveQuote = reserveQuote + grossQuoteIn;
  const postTradeMark = mulDiv(postReserveQuote, WAD, postReserveBase);

  return { actualBase, quoteAmount: grossQuoteIn, avgPrice, postTradeMark };
}

export function quoteSell({
  baseAmount,
  reserveBase,
  reserveQuote,
  minReserveQuote,
  feeBps,
}: {
  baseAmount: bigint;
  reserveBase: bigint;
  reserveQuote: bigint;
  minReserveQuote: bigint;
  feeBps: bigint;
}): QuoteResult {
  let grossBaseIn = baseAmount;
  const numerator = reserveQuote * grossBaseIn * (BPS_DENOMINATOR - feeBps);
  const denominator = reserveBase * BPS_DENOMINATOR + grossBaseIn * (BPS_DENOMINATOR - feeBps);
  let quoteOut = numerator / denominator;

  if (minReserveQuote > 0n) {
    const newReserveQuote = reserveQuote - quoteOut;
    if (newReserveQuote < minReserveQuote) {
      const maxQuoteOut = reserveQuote > minReserveQuote ? reserveQuote - minReserveQuote : 0n;
      if (maxQuoteOut <= 0n) throw new Error("Reserve quote depleted");
      quoteOut = maxQuoteOut;
      const f = BPS_DENOMINATOR - feeBps;
      grossBaseIn = mulDivRoundUp(maxQuoteOut, reserveBase * BPS_DENOMINATOR, f * minReserveQuote);
      if (grossBaseIn > baseAmount) grossBaseIn = baseAmount;
    }
  }

  if (quoteOut <= 0n) throw new Error("no out");

  const avgPrice = mulDiv(quoteOut, WAD, grossBaseIn);
  const postReserveBase = reserveBase + grossBaseIn;
  const postReserveQuote = reserveQuote - quoteOut;
  if (postReserveBase <= 0n) throw new Error("X=0");
  const postTradeMark = mulDiv(postReserveQuote, WAD, postReserveBase);
  if (postTradeMark <= 0n) throw new Error("Mark price zero");

  return { actualBase: grossBaseIn, quoteAmount: quoteOut, avgPrice, postTradeMark };
}

export function amountLimitFromPrice({
  isLong,
  sizeX18,
  limitPriceX18,
}: {
  isLong: boolean;
  sizeX18: bigint;
  limitPriceX18: bigint;
}): bigint {
  if (!limitPriceX18 || limitPriceX18 <= 0n || !sizeX18 || sizeX18 <= 0n) return 0n;
  return isLong
    ? mulDivRoundUp(sizeX18, limitPriceX18, WAD)
    : mulDiv(sizeX18, limitPriceX18, WAD);
}

export function buildOpenOrderPreview(params: BuildOpenOrderPreviewParams): OrderPreview {
  const {
    isLong,
    sizeX18,
    limitPriceX18 = 0n,
    reserveBase,
    reserveQuote,
    minReserveBase = 0n,
    minReserveQuote = 0n,
    feeBps = 0n,
    imrBps,
    mmrBps,
    oraclePrice,
    quoteFreeCollateral = 0n,
    minPositionSize = 0n,
    maxPositionSize = 0n,
    existingSizeX18 = 0n,
    existingMarginX18 = 0n,
    existingEntryPriceX18 = 0n,
    targetLeverageX18 = 0n,
  } = params;

  if (!sizeX18 || sizeX18 <= 0n) return ZERO_PREVIEW;
  if (!reserveBase || reserveBase <= 0n || !reserveQuote || reserveQuote <= 0n) {
    return { ...ZERO_PREVIEW, reason: "Market reserves unavailable" };
  }
  if (!oraclePrice || oraclePrice <= 0n) {
    return { ...ZERO_PREVIEW, reason: "Oracle price unavailable" };
  }
  if (!imrBps || imrBps <= 0n || !mmrBps || mmrBps <= 0n) {
    return { ...ZERO_PREVIEW, reason: "Risk parameters unavailable" };
  }

  try {
    const quote = isLong
      ? quoteBuy({ baseAmount: sizeX18, reserveBase, reserveQuote, minReserveBase, feeBps })
      : quoteSell({ baseAmount: sizeX18, reserveBase, reserveQuote, minReserveQuote, feeBps });

    const signedDelta = isLong ? quote.actualBase : -quote.actualBase;
    const resultingSize = existingSizeX18 + signedDelta;
    const resultingAbsSize = abs(resultingSize);
    if (minPositionSize > 0n && resultingAbsSize > 0n && resultingAbsSize < minPositionSize) {
      return { ...ZERO_PREVIEW, ...quote, ok: false, reason: "Below minimum position size" };
    }
    if (maxPositionSize > 0n && resultingAbsSize > maxPositionSize) {
      return { ...ZERO_PREVIEW, ...quote, ok: false, reason: "Above maximum position size" };
    }

    const tradeAbsSize = quote.actualBase;
    const imrPrice = max(quote.postTradeMark, oraclePrice);
    const riskNotional = mulDivRoundUp(tradeAbsSize, imrPrice, WAD);
    const initialMargin = mulDiv(riskNotional, imrBps, BPS_DENOMINATOR);
    const notional = mulDivRoundUp(tradeAbsSize, quote.avgPrice, WAD);
    const fee = mulDivRoundUp(notional, feeBps, BPS_DENOMINATOR);
    const projection = projectPositionAfterTrade({
      existingSizeX18,
      existingMarginX18,
      existingEntryPriceX18,
      signedBaseDeltaX18: signedDelta,
      executionPriceX18: quote.avgPrice,
      riskPriceX18: imrPrice,
      imrBps,
    });
    const resultingRiskNotional = mulDivRoundUp(resultingAbsSize, imrPrice, WAD);
    const displayNotional = mulDivRoundUp(resultingAbsSize, quote.postTradeMark, WAD);
    const targetMargin =
      targetLeverageX18 > 0n
        ? calculateTargetMargin({
            sizeX18: resultingSize,
            riskPriceX18: quote.postTradeMark,
            targetLeverageX18,
          })
        : projection.projectedMargin;
    const marginGap =
      targetMargin > projection.projectedMargin ? targetMargin - projection.projectedMargin : 0n;
    const extraMargin = marginGap > MARGIN_TOP_UP_DUST_X18 ? marginGap : 0n;
    const finalMargin = projection.projectedMargin + extraMargin;
    const totalRequired = projection.automaticMargin + fee + extraMargin;
    const availableWithRelease = quoteFreeCollateral + projection.marginReleased;
    const maintenanceMargin = mulDivRoundUp(
      mulDivRoundUp(resultingAbsSize, oraclePrice, WAD),
      mmrBps,
      BPS_DENOMINATOR,
    );
    const liqPrice = estimateLiquidationPrice({
      sizeX18: resultingSize,
      entryPriceX18: projection.resultingEntryPrice,
      marginX18: finalMargin,
      mmrBps,
    });
    const effectiveLeverageX18 = calculateLeverageX18({
      sizeX18: resultingSize,
      marginX18: finalMargin,
      riskPriceX18: imrPrice,
    });
    const displayLeverageX18 = calculateLeverageX18({
      sizeX18: resultingSize,
      marginX18: finalMargin,
      riskPriceX18: quote.postTradeMark,
    });
    const amountLimit = amountLimitFromPrice({ isLong, sizeX18: tradeAbsSize, limitPriceX18 });
    const limitInvalid =
      amountLimit > 0n &&
      (isLong ? amountLimit < quote.quoteAmount : amountLimit > quote.quoteAmount);

    const base: OrderPreview = {
      ...ZERO_PREVIEW,
      ...quote,
      notional,
      fee,
      initialMargin,
      automaticMargin: projection.automaticMargin,
      marginReleased: projection.marginReleased,
      projectedMargin: projection.projectedMargin,
      targetMargin,
      finalMargin,
      displayNotional,
      displayLeverageX18,
      extraMargin,
      maintenanceMargin,
      riskNotional,
      resultingRiskNotional,
      resultingSize,
      resultingEntryPrice: projection.resultingEntryPrice,
      totalRequired,
      effectiveLeverageX18,
      liqPrice,
      amountLimit,
    };

    if (limitInvalid) {
      return {
        ...base,
        ok: false,
        reason: isLong ? "Limit below executable cost" : "Limit above executable output",
      };
    }
    if (availableWithRelease < totalRequired) {
      return { ...base, ok: false, reason: "Insufficient quote collateral" };
    }
    return { ...base, ok: true, reason: null, actualBase: resultingAbsSize };
  } catch (error) {
    return {
      ...ZERO_PREVIEW,
      ok: false,
      reason: error instanceof Error ? error.message : "Order unavailable",
    };
  }
}

export function findMaxOpenSize(params: BuildOpenOrderPreviewParams): bigint {
  const imrBps = params.imrBps || 0n;
  const leverageCapacity =
    (params.targetLeverageX18 ?? 0n) > 0n
      ? (params.targetLeverageX18 as bigint)
      : imrBps > 0n
        ? mulDiv(BPS_DENOMINATOR, WAD, imrBps)
        : 0n;
  const availableCapital = (params.quoteFreeCollateral || 0n) + (params.existingMarginX18 || 0n);
  const upperByCollateral =
    params.oraclePrice && leverageCapacity > 0n
      ? mulDiv(availableCapital, leverageCapacity, params.oraclePrice)
      : 0n;
  let high =
    params.maxPositionSize && params.maxPositionSize > 0n
      ? params.maxPositionSize
      : upperByCollateral * 2n;
  if (high <= 0n) return 0n;

  const minReserveBase = params.minReserveBase ?? 0n;
  const reserveCap =
    params.isLong && minReserveBase > 0n
      ? params.reserveBase > minReserveBase
        ? params.reserveBase - minReserveBase
        : 0n
      : params.reserveBase;
  if (params.isLong && reserveCap > 0n && high > reserveCap - 1n) high = reserveCap - 1n;

  let low = 0n;
  for (let i = 0; i < 96; i += 1) {
    if (low + 1n >= high) break;
    const mid = (low + high) / 2n;
    const preview = buildOpenOrderPreview({ ...params, sizeX18: mid, limitPriceX18: 0n });
    if (preview.ok) low = mid;
    else high = mid;
  }
  return low;
}

export interface NotionalSizeResult {
  sizeX18: bigint;
  maxSizeX18: bigint;
  maxNotionalX18: bigint;
  preview: OrderPreview;
  ok: boolean;
  reason: string | null;
}

export function findBaseSizeForNotional(
  params: BuildOpenOrderPreviewParams,
  targetNotionalX18: bigint,
): NotionalSizeResult {
  if (!targetNotionalX18 || targetNotionalX18 <= 0n) {
    return {
      sizeX18: 0n,
      maxSizeX18: 0n,
      maxNotionalX18: 0n,
      preview: ZERO_PREVIEW,
      ok: false,
      reason: "Enter a notional",
    };
  }

  const maxSizeX18 = findMaxOpenSize(params);
  if (maxSizeX18 <= 0n) {
    const preview = buildOpenOrderPreview({ ...params, sizeX18: targetNotionalX18, limitPriceX18: 0n });
    return {
      sizeX18: 0n,
      maxSizeX18,
      maxNotionalX18: 0n,
      preview,
      ok: false,
      reason: preview.reason || "No executable size available",
    };
  }

  const maxPreview = buildOpenOrderPreview({ ...params, sizeX18: maxSizeX18, limitPriceX18: 0n });
  const maxNotionalX18 = maxPreview.ok ? maxPreview.displayNotional : 0n;
  if (maxNotionalX18 <= 0n) {
    return {
      sizeX18: 0n,
      maxSizeX18,
      maxNotionalX18: 0n,
      preview: maxPreview,
      ok: false,
      reason: maxPreview.reason || "No executable notional available",
    };
  }

  const tolerance = max(1n, targetNotionalX18 / 10000n);
  if (targetNotionalX18 > maxNotionalX18 + tolerance) {
    return {
      sizeX18: maxSizeX18,
      maxSizeX18,
      maxNotionalX18,
      preview: maxPreview,
      ok: false,
      reason: "Above maximum executable notional",
    };
  }

  let low = 0n;
  let high = maxSizeX18;
  let bestSize = 0n;
  let bestPreview = ZERO_PREVIEW;
  let bestDiff = targetNotionalX18;

  for (let i = 0; i < 96; i += 1) {
    if (low + 1n >= high) break;
    const mid = (low + high) / 2n;
    const preview = buildOpenOrderPreview({ ...params, sizeX18: mid, limitPriceX18: 0n });
    if (!preview.ok) {
      high = mid;
      continue;
    }
    const diff = abs(preview.displayNotional - targetNotionalX18);
    if (bestSize === 0n || diff < bestDiff) {
      bestSize = mid;
      bestPreview = preview;
      bestDiff = diff;
    }
    if (preview.displayNotional === targetNotionalX18) break;
    if (preview.displayNotional < targetNotionalX18) low = mid;
    else high = mid;
  }

  for (const candidate of [low, high]) {
    if (candidate <= 0n || candidate > maxSizeX18) continue;
    const preview = buildOpenOrderPreview({ ...params, sizeX18: candidate, limitPriceX18: 0n });
    if (!preview.ok) continue;
    const diff = abs(preview.displayNotional - targetNotionalX18);
    if (bestSize === 0n || diff < bestDiff) {
      bestSize = candidate;
      bestPreview = preview;
      bestDiff = diff;
    }
  }

  if (bestSize <= 0n) {
    return {
      sizeX18: 0n,
      maxSizeX18,
      maxNotionalX18,
      preview: ZERO_PREVIEW,
      ok: false,
      reason: "Unable to derive executable size",
    };
  }

  if (bestPreview.displayNotional > targetNotionalX18 + tolerance) {
    return {
      sizeX18: bestSize,
      maxSizeX18,
      maxNotionalX18,
      preview: bestPreview,
      ok: false,
      reason: "Below minimum executable notional",
    };
  }

  return { sizeX18: bestSize, maxSizeX18, maxNotionalX18, preview: bestPreview, ok: true, reason: null };
}

export function toNumberX18(value: bigint | null | undefined): number {
  if (value == null) return 0;
  return Number(value) / 1e18;
}

export function formatX18Number(value: bigint | null | undefined, digits = 2): string {
  return toNumberX18(value).toFixed(digits);
}
