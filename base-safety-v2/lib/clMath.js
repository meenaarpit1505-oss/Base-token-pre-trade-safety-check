/**
 * Concentrated-liquidity (Uniswap V3 / Aerodrome Slipstream / Uniswap V4) price-impact math.
 *
 * Pure functions, float math on raw (undecimalized) units. Inside one initialized-tick range a CL pool behaves
 * exactly like a constant-product pool with virtual reserves x = L / sqrtP, y = L * sqrtP, so a swap is simulated
 * segment by segment: consume the range up to the next initialized tick, apply that tick's liquidityNet, repeat.
 * Beyond the scanned window the liquidity profile is unknown and the simulation reports `exhausted`.
 *
 * Fees are ignored (they make real impact slightly worse; < 1% for standard tiers).
 */

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
const Q96 = 2 ** 96;

export const sqrtX96ToFloat = (v) => (typeof v === 'bigint' ? Number(v) / Q96 : Number(v) / Q96);
export const tickToSqrtPrice = (tick) => Math.pow(1.0001, tick / 2);
const clampTick = (t) => Math.max(MIN_TICK, Math.min(MAX_TICK, t));

/** Uniswap V3 fee tier -> tick spacing (official factory defaults). */
export function tickSpacingForFee(fee) {
  return { 100: 1, 500: 10, 3000: 60, 10000: 200 }[fee] ?? null;
}

/** Compressed tick + bitmap word position exactly as TickBitmap.sol (floor division, int16 word, uint8 bit). */
export function bitmapPosition(tick, tickSpacing) {
  const compressed = Math.floor(tick / tickSpacing);
  return { compressed, wordPos: compressed >> 8, bitPos: compressed & 255 };
}

/** Word positions to fetch for a +/-1 word window around the current tick. */
export function bitmapWordsFor(tick, tickSpacing) {
  const { wordPos } = bitmapPosition(tick, tickSpacing);
  return [wordPos - 1, wordPos, wordPos + 1];
}

function setBits(word) {
  const out = [];
  if (typeof word !== 'bigint' || word === 0n) return out;
  for (let i = 0; i < 256; i++) if ((word >> BigInt(i)) & 1n) out.push(i);
  return out;
}

/**
 * From fetched bitmap words, list initialized ticks below/at (down, descending) and above (up, ascending)
 * the current tick, plus the window edges where knowledge ends.
 * @param {Map<number, bigint>|null} words wordPos -> bitmap; null => no tick data (tick-spacing fallback)
 */
export function initializedTicks(words, tick, tickSpacing) {
  const { compressed, wordPos } = bitmapPosition(tick, tickSpacing);
  if (!words || ![wordPos - 1, wordPos, wordPos + 1].every((w) => words.has(w))) {
    // Liquidity is provably constant between the two tick-spacing multiples around the current tick.
    return { down: [], up: [], downEdge: clampTick(compressed * tickSpacing), upEdge: clampTick((compressed + 1) * tickSpacing), source: 'tick_spacing_bound' };
  }
  const all = [];
  for (const w of [wordPos - 1, wordPos, wordPos + 1]) for (const b of setBits(words.get(w))) all.push(w * 256 + b);
  const down = all.filter((c) => c <= compressed).sort((a, b) => b - a).map((c) => c * tickSpacing);
  const up = all.filter((c) => c > compressed).sort((a, b) => a - b).map((c) => c * tickSpacing);
  return {
    down,
    up,
    downEdge: clampTick(((wordPos - 1) * 256 - 1) * tickSpacing),
    upEdge: clampTick((wordPos + 2) * 256 * tickSpacing),
    source: 'tick_bitmap',
  };
}

/**
 * Build a piecewise-constant liquidity profile.
 * @param {{sqrtP:number, L:number, ticks:ReturnType<typeof initializedTicks>, netByTick?:Map<number, number>, maxTicks?:number}} p
 * Ticks whose liquidityNet is unknown terminate the known profile on that side (edge = that tick).
 */
export function buildProfile({ sqrtP, L, ticks, netByTick = new Map(), maxTicks = 8 }) {
  const side = (list, edge) => {
    const steps = [];
    for (const t of list.slice(0, maxTicks)) {
      if (!netByTick.has(t)) return { steps, edge: t };
      steps.push({ tick: t, net: netByTick.get(t) });
    }
    // More initialized ticks than we resolved => knowledge ends at the next one.
    return { steps, edge: list.length > steps.length ? list[steps.length] : edge };
  };
  const d = side(ticks.down, ticks.downEdge);
  const u = side(ticks.up, ticks.upEdge);
  return { sqrtP, L, down: d.steps, downEdge: d.edge, up: u.steps, upEdge: u.edge, source: ticks.source };
}

/**
 * Simulate swapping `amountIn` raw units into the pool.
 * zeroForOne=true: token0 in, price (token1/token0) falls, walk `down`. Otherwise token1 in, walk `up`.
 * @returns {{impact:number, crossed:number, exhausted:boolean, filledFraction:number, endSqrtP:number}}
 *   impact = relative drop of the input token's price in output-token terms (0..1).
 */
export function simulateSwap(profile, amountIn, zeroForOne, liquidityScale = 1) {
  const s0 = profile.sqrtP;
  if (!(s0 > 0) || !(amountIn > 0)) return { impact: 0, crossed: 0, exhausted: false, filledFraction: 1, endSqrtP: s0 };
  let L = profile.L * liquidityScale;
  let s = s0;
  let rem = amountIn;
  let crossed = 0;
  const steps = zeroForOne ? profile.down : profile.up;
  const edge = zeroForOne ? profile.downEdge : profile.upEdge;
  const boundaries = [...steps.map((x) => ({ tick: x.tick, net: x.net * liquidityScale })), { tick: edge, net: null }];
  for (const b of boundaries) {
    const sb = tickToSqrtPrice(b.tick);
    if (zeroForOne ? sb >= s : sb <= s) {
      // Boundary at/behind the current price (tick exactly on an initialized tick): cross without consuming.
      if (b.net === null) break;
      L = Math.max(0, L + (zeroForOne ? -b.net : b.net));
      crossed++;
      continue;
    }
    const cap = L > 0 ? (zeroForOne ? L * (1 / sb - 1 / s) : L * (sb - s)) : 0;
    if (rem <= cap) {
      s = zeroForOne ? 1 / (1 / s + rem / L) : s + rem / L;
      rem = 0;
      break;
    }
    rem -= cap;
    s = sb;
    if (b.net === null) break; // ran off the known window
    L = Math.max(0, L + (zeroForOne ? -b.net : b.net));
    crossed++;
  }
  const ratio = zeroForOne ? (s / s0) ** 2 : (s0 / s) ** 2;
  return { impact: Math.min(1, Math.max(0, 1 - ratio)), crossed, exhausted: rem > 0, filledFraction: 1 - rem / amountIn, endSqrtP: s };
}

/** Token amounts held by in-range liquidity inside the known window (token1 below price, token0 above). */
export function windowAmounts(profile) {
  const walk = (steps, edge, below) => {
    let L = profile.L;
    let s = profile.sqrtP;
    let amt = 0;
    for (const b of [...steps, { tick: edge, net: null }]) {
      const sb = tickToSqrtPrice(b.tick);
      if (below ? sb < s : sb > s) amt += below ? L * (s - sb) : L * (1 / s - 1 / sb);
      s = below ? Math.min(s, sb) : Math.max(s, sb);
      if (b.net === null) break;
      L = Math.max(0, L + (below ? -b.net : b.net));
    }
    return amt;
  };
  return { token1Below: walk(profile.down, profile.downEdge, true), token0Above: walk(profile.up, profile.upEdge, false) };
}

/** Constant-product marginal price impact of selling `size` USD into a pool with `depth` USD (both sides). */
export function cpImpact(depth, size) {
  if (!(size > 0)) return 0;
  const h = depth / 2;
  return h > 0 ? 1 - (h / (h + size)) ** 2 : 1;
}

/** Inverse of cpImpact: the CP-equivalent depth that would produce `impact` for `size`. */
export function cpDepthFromImpact(impact, size) {
  if (!(size > 0)) return Infinity;
  if (!(impact > 0)) return Infinity;
  if (impact >= 1) return 0;
  const s = Math.sqrt(1 - impact);
  return (2 * size * s) / (1 - s);
}
