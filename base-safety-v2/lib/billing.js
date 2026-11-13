/**
 * Optional payment gate for /api/analyze and MCP tools/call (mirrors origin-api/src/http/billing.ts + x402.ts).
 *
 *   BILLING_MODE=open     (default) no payment, behaviour unchanged.
 *   BILLING_MODE=api_key  caller sends X-Api-Key; each paid call runs Supabase RPC
 *                         deduct_api_key_balance(p_key, p_cost) (origin-api/supabase/migrations/*_api_keys.sql).
 *   BILLING_MODE=x402     caller without payment gets HTTP 402 + PAYMENT-REQUIRED (x402 v2, exact scheme, USDC on
 *                         Base via EIP-3009). PAYMENT-SIGNATURE (or X-Payment) is verified with the facilitator
 *                         before the analysis runs and settled after it succeeds; the result is only returned once
 *                         settlement succeeds.
 *
 * Fail closed: an unknown mode, or a non-open mode with missing / invalid config, answers 503 and never runs the
 * engine for free. No pay-to address or facilitator is built in: both come from the environment only.
 * Edge-runtime safe (no Buffer, no node: imports).
 */
import { getAddress, isAddress } from 'viem';
import { getSupabase } from './cacheLayer.js';

export const X402_VERSION = 2;
export const DEDUCT_API_KEY_RPC = 'deduct_api_key_balance';
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ZERO = '0x0000000000000000000000000000000000000000';

const readEnv = (source, k) => {
  try {
    const v = source?.[k];
    return typeof v === 'string' ? v.trim() : '';
  } catch {
    return '';
  }
};
const defaultEnv = () => {
  try {
    return globalThis.process?.env ?? {};
  } catch {
    return {};
  }
};
const numOr = (raw, d) => {
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) ? n : d;
};

function isLocalHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/** Parse billing config from env. `errors` non-empty => fail closed (503) for any non-open mode. */
export function loadBillingConfig(source = defaultEnv()) {
  const errors = [];
  const rawMode = (readEnv(source, 'BILLING_MODE') || 'open').toLowerCase();
  const mode = ['open', 'api_key', 'x402'].includes(rawMode) ? rawMode : 'invalid';
  if (mode === 'invalid') errors.push('BILLING_MODE must be open, api_key, or x402');

  const priceUsd = numOr(readEnv(source, 'PRICE_USD'), 0.01);
  let amount = null;
  try {
    amount = usdcAtomicUnits(priceUsd);
  } catch (e) {
    if (mode !== 'open') errors.push(e.message);
  }

  const cfg = {
    mode,
    priceUsd,
    amount,
    payTo: '',
    facilitatorUrl: '',
    facilitatorAuth: readEnv(source, 'X402_FACILITATOR_AUTH'),
    acceptStub: readEnv(source, 'X402_ACCEPT_STUB').toLowerCase() === 'true', // default false (unlike origin-api's dev default)
    network: readEnv(source, 'X402_NETWORK') || 'eip155:8453',
    asset: readEnv(source, 'X402_ASSET') || BASE_USDC,
    assetName: '',
    assetVersion: '',
    maxTimeoutSeconds: Math.min(3600, Math.max(1, numOr(readEnv(source, 'X402_MAX_TIMEOUT_SECONDS'), 60))),
    verifyTimeoutMs: Math.max(100, numOr(readEnv(source, 'X402_VERIFY_TIMEOUT_MS'), 2500)),
    settleTimeoutMs: Math.max(100, numOr(readEnv(source, 'X402_SETTLE_TIMEOUT_MS'), 8000)),
    supabaseConfigured: Boolean(readEnv(source, 'SUPABASE_URL') && readEnv(source, 'SUPABASE_SERVICE_ROLE_KEY')),
    errors,
  };

  if (mode === 'api_key' && !cfg.supabaseConfigured) errors.push('BILLING_MODE=api_key needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');

  if (mode === 'x402') {
    if (!/^eip155:[1-9]\d*$/.test(cfg.network)) errors.push('X402_NETWORK must be a CAIP-2 eip155 identifier');
    if (!isAddress(cfg.asset)) errors.push('X402_ASSET must be an EVM address');
    else cfg.asset = getAddress(cfg.asset);
    const isUsdc = isAddress(cfg.asset) && cfg.asset.toLowerCase() === BASE_USDC.toLowerCase();
    cfg.assetName = readEnv(source, 'X402_ASSET_NAME') || (isUsdc ? 'USD Coin' : '');
    cfg.assetVersion = readEnv(source, 'X402_ASSET_VERSION') || (isUsdc ? '2' : '');
    if (!cfg.assetName || !cfg.assetVersion) errors.push('X402_ASSET_NAME and X402_ASSET_VERSION are required when X402_ASSET is not Base USDC');

    const payTo = readEnv(source, 'X402_PAY_TO');
    if (payTo) {
      if (!isAddress(payTo)) errors.push('X402_PAY_TO must be an EVM address');
      else if (payTo.toLowerCase() === ZERO) errors.push('X402_PAY_TO must not be the zero address');
      else cfg.payTo = getAddress(payTo);
    }
    const fac = readEnv(source, 'X402_FACILITATOR_URL');
    if (fac) {
      try {
        const u = new URL(fac);
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalHost(u.hostname))) errors.push('X402_FACILITATOR_URL must be https (http only for localhost)');
        else if (u.username || u.password) errors.push('X402_FACILITATOR_URL must not embed credentials (use X402_FACILITATOR_AUTH)');
        else cfg.facilitatorUrl = u.toString();
      } catch {
        errors.push('X402_FACILITATOR_URL is not a valid URL');
      }
    }
    // Real settlement needs both. Stub-only testing is allowed explicitly via X402_ACCEPT_STUB=true.
    if (!cfg.acceptStub && (!cfg.payTo || !cfg.facilitatorUrl)) {
      const missing = [cfg.payTo ? null : 'X402_PAY_TO', cfg.facilitatorUrl ? null : 'X402_FACILITATOR_URL'].filter(Boolean);
      errors.push(`BILLING_MODE=x402 needs ${missing.join(' and ')} (or X402_ACCEPT_STUB=true for testing only)`);
    }
  }
  return cfg;
}

let memo;
/** Env is fixed for the life of a process: parse once. */
export function getBillingConfig() {
  return (memo ??= loadBillingConfig());
}

export function usdcAtomicUnits(priceUsd) {
  const atomic = Math.round(Number(priceUsd) * 1_000_000);
  if (!Number.isSafeInteger(atomic) || atomic < 1) throw new Error('PRICE_USD must convert to a positive USDC amount with 6 decimals');
  return String(atomic);
}

export function settlementGap(cfg) {
  if (cfg.payTo && cfg.facilitatorUrl) return null;
  const missing = [cfg.payTo ? null : 'X402_PAY_TO', cfg.facilitatorUrl ? null : 'X402_FACILITATOR_URL'].filter(Boolean);
  return `Real x402 settlement is not live yet. Set ${missing.join(' and ')}.`;
}

export function paymentRequirements(cfg) {
  return {
    scheme: 'exact',
    network: cfg.network,
    amount: cfg.amount,
    asset: cfg.asset,
    payTo: cfg.payTo,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds,
    extra: { assetTransferMethod: 'eip3009', name: cfg.assetName, version: cfg.assetVersion },
  };
}

export function paymentRequiredDocument(cfg, resourceUrl, error) {
  return {
    x402Version: X402_VERSION,
    error,
    resource: { url: resourceUrl, description: 'Base token pre-trade safety check', mimeType: 'application/json' },
    accepts: cfg.payTo ? [paymentRequirements(cfg)] : [],
  };
}

// --- base64 JSON (edge-safe) -------------------------------------------------------------------------------------
export function encodePaymentHeader(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function decodeHeader(header) {
  const t = String(header ?? '').trim();
  if (!t || t.length > 12_000) return { ok: false, reason: 'Payment header is empty or too large.' };
  try {
    let json = t;
    if (!t.startsWith('{')) {
      const bin = atob(t);
      json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    }
    const v = JSON.parse(json);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, reason: 'Payment header is not a JSON object.' };
    return { ok: true, value: v };
  } catch {
    return { ok: false, reason: 'Payment header is not valid base64 JSON.' };
  }
}
const strField = (o, k) => (typeof o[k] === 'string' && o[k].length > 0 && o[k].length < 200 ? o[k] : null);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export function parsePaymentHeader(header) {
  const d = decodeHeader(header);
  if (!d.ok) return d;
  const raw = d.value;
  if (raw.x402Version !== X402_VERSION) return { ok: false, reason: 'Only x402 version 2 payments are accepted.' };
  const payload = raw.payload;
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'Payment payload is missing.' };
  const auth = payload.authorization;
  if (!auth || typeof auth !== 'object' || typeof payload.signature !== 'string') {
    return { ok: false, reason: 'Payment payload must include an EIP-3009 authorization and signature.' };
  }
  const [from, to, value, validAfter, validBefore, nonce] = ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'].map((k) => strField(auth, k));
  if (!from || !to || !value || !validAfter || !validBefore || !nonce) return { ok: false, reason: 'EIP-3009 authorization is incomplete.' };
  if (!isAddress(from) || !isAddress(to)) return { ok: false, reason: 'Payment authorization addresses are invalid.' };
  if (![value, validAfter, validBefore].every((x) => /^\d+$/.test(x))) return { ok: false, reason: 'Payment authorization amounts must be decimal integers.' };
  if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) return { ok: false, reason: 'Payment nonce must be a 32-byte hex value.' };
  if (!/^0x[0-9a-fA-F]{130}$/.test(payload.signature)) return { ok: false, reason: 'Payment signature must be a 65-byte hex value.' };
  if (!raw.accepted || typeof raw.accepted !== 'object') return { ok: false, reason: 'Payment payload is missing accepted requirements.' };
  return { ok: true, payment: { raw, payer: getAddress(from), nonce: nonce.toLowerCase(), value, validBefore: Number(validBefore) } };
}

export function rejectionReason(payment, req, nowSec) {
  const a = payment.raw.accepted;
  if (a.scheme !== req.scheme) return 'Payment scheme must be exact.';
  if (a.network !== req.network) return `Payment network must be ${req.network}.`;
  if (typeof a.asset !== 'string' || !same(a.asset, req.asset)) return 'Payment asset must be the configured USDC contract.';
  if (typeof a.payTo !== 'string' || !same(a.payTo, req.payTo)) return 'Payment recipient does not match X402_PAY_TO.';
  if (a.amount !== req.amount) return `Payment amount must be ${req.amount} atomic units.`;
  const auth = payment.raw.payload.authorization;
  if (!same(auth.to, req.payTo)) return 'Authorization recipient does not match X402_PAY_TO.';
  if (String(auth.value) !== req.amount) return `Authorization value must be ${req.amount}.`;
  const va = Number(auth.validAfter);
  const vb = Number(auth.validBefore);
  if (!Number.isSafeInteger(va) || !Number.isSafeInteger(vb) || vb <= va) return 'Payment validity window is invalid.';
  if (nowSec < va || nowSec >= vb) return 'Payment authorization is outside its validity window.';
  if (vb - nowSec > req.maxTimeoutSeconds) return 'Payment validity window is longer than maxTimeoutSeconds.';
  const method = a.extra && typeof a.extra === 'object' ? a.extra.assetTransferMethod : undefined;
  if (method !== undefined && method !== 'eip3009') return 'Only EIP-3009 transferWithAuthorization payments are accepted.';
  return null;
}

// --- nonce replay guard (per instance; the facilitator / USDC contract is the final guard) ----------------------
const nonces = new Map();
export function reserveNonce(nonce, holdMs) {
  const now = Date.now();
  for (const [k, exp] of nonces) if (exp <= now) nonces.delete(k);
  const k = nonce.toLowerCase();
  if ((nonces.get(k) ?? 0) > now) return false;
  nonces.set(k, now + holdMs);
  return true;
}
export const releaseNonce = (nonce) => nonces.delete(nonce.toLowerCase());
export const holdNonce = (nonce, untilSec) => nonces.set(nonce.toLowerCase(), Math.max(Date.now() + 60_000, untilSec * 1000));
export const resetNoncesForTests = () => nonces.clear();

function reasonText(v) {
  return typeof v === 'string' && /^[a-z0-9_]{1,64}$/i.test(v) ? `Payment was rejected (${v}).` : 'Payment was rejected by the facilitator.';
}
const authHeader = (v) => (/^[A-Za-z][A-Za-z0-9._-]*\s+\S+$/.test(v) ? v : `Bearer ${v}`);

export async function facilitatorCall(kind, payment, req, cfg, fetchImpl = globalThis.fetch) {
  if (!cfg.facilitatorUrl) return { ok: false, reason: 'x402 facilitator is not configured.' };
  const base = cfg.facilitatorUrl.endsWith('/') ? cfg.facilitatorUrl : `${cfg.facilitatorUrl}/`;
  const endpoint = new URL(kind, base).toString();
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (cfg.facilitatorAuth) headers.authorization = authHeader(cfg.facilitatorAuth);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), kind === 'verify' ? cfg.verifyTimeoutMs : cfg.settleTimeoutMs);
  let res;
  let body = {};
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload: payment, paymentRequirements: req }),
      signal: controller.signal,
      redirect: 'error',
    });
    const text = await res.text();
    if (text.length <= 100_000) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') body = parsed;
      } catch {
        /* non-JSON */
      }
    }
  } catch {
    return { ok: false, reason: 'x402 facilitator did not respond.' };
  } finally {
    clearTimeout(timer);
  }
  const payer = typeof body.payer === 'string' && isAddress(body.payer) ? getAddress(body.payer) : undefined;
  if (kind === 'verify') return res.ok && body.isValid === true ? { ok: true, reason: '', payer } : { ok: false, reason: reasonText(body.invalidReason) };
  if (res.ok && body.success === true) {
    return { ok: true, reason: '', payer, transaction: typeof body.transaction === 'string' ? body.transaction : undefined, network: typeof body.network === 'string' ? body.network : undefined };
  }
  return { ok: false, reason: reasonText(body.errorReason ?? body.invalidReason) };
}

// --- Supabase prepaid key deduction -------------------------------------------------------------------------------
const formatUsd = (n) => n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
export async function deductApiKey(key, cost, rpc) {
  const k = String(key ?? '').trim();
  if (!k || k.length > 256 || !Number.isFinite(cost) || cost <= 0 || typeof rpc !== 'function') return false;
  try {
    const { data, error } = await rpc(DEDUCT_API_KEY_RPC, { p_key: k, p_cost: formatUsd(cost) });
    if (error) {
      console.warn('[billing] deduct_api_key_balance failed:', String(error.message ?? error).slice(0, 200));
      return false;
    }
    return data === true;
  } catch (e) {
    console.warn('[billing] deduct_api_key_balance threw:', String(e?.message ?? e).slice(0, 200));
    return false;
  }
}

// --- Gate --------------------------------------------------------------------------------------------------------
export const BILLING_CORS_HEADERS = {
  'access-control-allow-headers': 'content-type, x-api-key, payment-signature, x-payment, mcp-protocol-version',
  'access-control-expose-headers': 'payment-required, payment-response, x-price-usd, x-billing-mode',
};

export function billingHeaders(cfg) {
  if (cfg.mode === 'open') return {};
  return { 'x-billing-mode': cfg.mode, 'x-price-usd': Number(cfg.priceUsd).toFixed(2) };
}

function deny(cfg, status, body, extraHeaders = {}) {
  return { ok: false, status, body, headers: { ...billingHeaders(cfg), ...extraHeaders } };
}

function paymentRequired(cfg, resourceUrl, message) {
  const doc = paymentRequiredDocument(cfg, resourceUrl, message);
  return deny(
    cfg,
    402,
    { error: 'payment_required', message, priceUsd: cfg.priceUsd, payTo: cfg.payTo || null, network: cfg.network, scheme: 'x402', x402Version: X402_VERSION, amount: cfg.amount, asset: cfg.asset, accepts: doc.accepts },
    { 'payment-required': encodePaymentHeader(doc) },
  );
}

function unpaidMessage(cfg) {
  const gap = settlementGap(cfg);
  if (cfg.acceptStub) return `Send PAYMENT-SIGNATURE as base64 x402 v2 JSON, or X-Payment: stub:<client-id> (testing).${gap ? ' ' + gap : ''}`;
  return gap ?? 'Send PAYMENT-SIGNATURE as a base64 x402 version 2 payment payload.';
}

/**
 * Authorize one paid call. Returns
 *   { ok: true, identity, headers, finalize(): Promise<{ok, headers} | deny> }   -> run the analysis, then finalize()
 *   { ok: false, status, body, headers }                                         -> send as-is, do not run analysis
 * deps: { cfg, rpc, fetch, now }  (all optional; tests inject them)
 */
export async function authorizeCall(request, deps = {}) {
  const cfg = deps.cfg ?? getBillingConfig();
  const okResult = (identity, finalize) => ({ ok: true, identity, headers: billingHeaders(cfg), finalize: finalize ?? (async () => ({ ok: true, headers: {} })) });
  if (cfg.mode === 'open') return okResult('anonymous');
  if (cfg.errors.length) {
    console.error('[billing] misconfigured, failing closed:', cfg.errors.join('; '));
    return deny(cfg, 503, { error: 'billing_not_configured', message: 'Billing is enabled but not fully configured on this server; no free calls are served.', missing: cfg.errors });
  }
  const h = (name) => request.headers.get(name)?.trim() ?? '';

  if (cfg.mode === 'api_key') {
    const key = h('x-api-key');
    if (!key || key.length > 256) return deny(cfg, 401, { error: 'unauthorized', message: 'Send a prepaid X-Api-Key header.' });
    let rpc = deps.rpc;
    if (rpc === undefined) {
      const sb = getSupabase();
      rpc = sb ? (fn, args) => sb.rpc(fn, args) : null;
    }
    if (!rpc) return deny(cfg, 503, { error: 'billing_not_configured', message: 'Supabase is not reachable; no free calls are served.' });
    const charged = await deductApiKey(key, cfg.priceUsd, rpc);
    if (!charged) return deny(cfg, 402, { error: 'insufficient_balance', message: `X-Api-Key is unknown, inactive, or has less than $${cfg.priceUsd} balance.` });
    return okResult(`key:${key.slice(0, 6)}…`);
  }

  // x402
  const resourceUrl = deps.resourceUrl ?? request.url;
  const payment = h('payment-signature') || h('x-payment');
  if (!payment || payment.length > 12_000) return paymentRequired(cfg, resourceUrl, unpaidMessage(cfg));
  if (cfg.acceptStub && payment.startsWith('stub:')) {
    if (!/^stub:[A-Za-z0-9._:-]{1,64}$/.test(payment)) return paymentRequired(cfg, resourceUrl, 'X-Payment stub must look like stub:<client-id>.');
    return okResult(`x402:${payment.slice(0, 64)}`);
  }
  const gap = settlementGap(cfg);
  if (gap) return paymentRequired(cfg, resourceUrl, `${gap} No payment was submitted.`);
  const parsed = parsePaymentHeader(payment);
  if (!parsed.ok) return paymentRequired(cfg, resourceUrl, parsed.reason);
  const req = paymentRequirements(cfg);
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const reason = rejectionReason(parsed.payment, req, now);
  if (reason) return paymentRequired(cfg, resourceUrl, reason);
  if (!reserveNonce(parsed.payment.nonce, 120_000)) return paymentRequired(cfg, resourceUrl, 'This payment nonce is already in use.');
  const verified = await facilitatorCall('verify', parsed.payment.raw, req, cfg, deps.fetch);
  if (!verified.ok) {
    releaseNonce(parsed.payment.nonce);
    return paymentRequired(cfg, resourceUrl, verified.reason);
  }
  const payer = (verified.payer ?? parsed.payment.payer).toLowerCase();
  let finalized = false;
  return okResult(`x402:${payer}`, async ({ success = true } = {}) => {
    if (finalized) return { ok: true, headers: {} };
    finalized = true;
    if (!success) {
      releaseNonce(parsed.payment.nonce);
      return { ok: true, headers: {} };
    }
    const settled = await facilitatorCall('settle', parsed.payment.raw, req, cfg, deps.fetch);
    if (!settled.ok) {
      releaseNonce(parsed.payment.nonce);
      return paymentRequired(cfg, resourceUrl, settled.reason);
    }
    holdNonce(parsed.payment.nonce, parsed.payment.validBefore);
    return {
      ok: true,
      headers: { 'payment-response': encodePaymentHeader({ success: true, payer: settled.payer ?? payer, transaction: settled.transaction ?? '', network: settled.network ?? cfg.network }) },
    };
  });
}
