import { ENV } from '../config/env';
import CoinGeckoCache from '../models/CoinGeckoCache';
import { logger } from '../utils/logger';

const DEMO_BASE = 'https://api.coingecko.com/api/v3';
const PRO_BASE = 'https://pro-api.coingecko.com/api/v3';

const ALLOWED_PATH =
  /^(nfts\/markets|nfts\/list|nfts\/market_chart\/global|nfts\/[a-zA-Z0-9_-]+(?:\/market_chart)?|search\/trending|coins\/markets)(\?.*)?$/;

export interface MarketProxyResult {
  status: number;
  body: unknown;
}

/** In-process coalescing: concurrent misses for the same key share one upstream fetch. */
const inflight = new Map<string, Promise<MarketProxyResult>>();

function normalizePath(path: string): string {
  return path.replace(/^\//, '').trim();
}

function isAllowedPath(path: string): boolean {
  const normalized = normalizePath(path);
  if (normalized.includes('..')) return false;
  return ALLOWED_PATH.test(normalized);
}

function getApiKey(): string {
  const key = ENV.COINGECKO_API_KEY.replace(/^["']|["']$/g, '').trim();
  if (!key) throw new Error('CoinGecko API key not configured');
  return key;
}

function cacheTtlMs(): number {
  const ttl = Number(ENV.COINGECKO_CACHE_TTL_MS);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 120_000;
}

async function fetchUpstream(normalized: string): Promise<MarketProxyResult> {
  let apiKey: string;
  try {
    apiKey = getApiKey();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'CoinGecko API key not configured';
    return { status: 500, body: { error: message } };
  }

  const isDemo = apiKey.startsWith('CG-');
  const base = isDemo ? DEMO_BASE : PRO_BASE;
  const headerName = isDemo ? 'x-cg-demo-api-key' : 'x-cg-pro-api-key';
  const url = `${base}/${normalized}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        [headerName]: apiKey,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        status: res.status,
        body: {
          error: `CoinGecko API error: ${res.status} ${res.statusText}`,
          details: text.slice(0, 500),
        },
      };
    }

    return { status: 200, body: await res.json() };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      status: 502,
      body: { error: 'Failed to fetch from CoinGecko', details: message },
    };
  }
}

async function refreshAndCache(key: string): Promise<MarketProxyResult> {
  const upstream = await fetchUpstream(key);

  if (upstream.status === 200) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + cacheTtlMs());
    try {
      await CoinGeckoCache.findOneAndUpdate(
        { key },
        {
          key,
          path: key,
          statusCode: 200,
          body: upstream.body,
          fetchedAt: now,
          expiresAt,
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      );
      logger.info(`[CoinGeckoCache] stored key=${key} ttlMs=${cacheTtlMs()}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[CoinGeckoCache] failed to persist key=${key}: ${message}`);
    }
    return upstream;
  }

  // Upstream failed — prefer stale cache over an error when available.
  try {
    const stale = await CoinGeckoCache.findOne({ key }).lean();
    if (stale?.body != null) {
      logger.warn(
        `[CoinGeckoCache] upstream ${upstream.status} for key=${key}; serving stale fetchedAt=${stale.fetchedAt?.toISOString?.() ?? stale.fetchedAt}`,
      );
      return { status: 200, body: stale.body };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[CoinGeckoCache] stale lookup failed key=${key}: ${message}`);
  }

  return upstream;
}

export class CoinGeckoService {
  static isAllowedPath(path: string): boolean {
    return isAllowedPath(path);
  }

  static async get(path: string): Promise<MarketProxyResult> {
    if (!isAllowedPath(path)) {
      return { status: 400, body: { error: 'Path is not allowlisted' } };
    }

    const key = normalizePath(path);
    const now = new Date();

    try {
      const cached = await CoinGeckoCache.findOne({ key }).lean();
      if (cached?.body != null && cached.expiresAt && new Date(cached.expiresAt) > now) {
        logger.info(`[CoinGeckoCache] HIT key=${key}`);
        return { status: 200, body: cached.body };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[CoinGeckoCache] read failed key=${key}: ${message}`);
    }

    let pending = inflight.get(key);
    if (!pending) {
      logger.info(`[CoinGeckoCache] MISS key=${key} — refreshing`);
      pending = refreshAndCache(key).finally(() => {
        inflight.delete(key);
      });
      inflight.set(key, pending);
    } else {
      logger.info(`[CoinGeckoCache] COALESCE key=${key}`);
    }

    return pending;
  }

  /** ETH/USD spot from CoinGecko `/coins/markets` (served via Mongo cache). */
  static async getEthUsdPrice(): Promise<MarketProxyResult> {
    const result = await CoinGeckoService.get('coins/markets?vs_currency=usd&ids=ethereum');
    if (result.status !== 200) return result;

    const list = Array.isArray(result.body) ? result.body : [];
    const usd = Number((list[0] as { current_price?: number } | undefined)?.current_price);
    if (!Number.isFinite(usd) || usd <= 0) {
      return { status: 502, body: { error: 'ETH/USD price unavailable' } };
    }

    return { status: 200, body: { usd } };
  }
}
