import { ENV } from '../config/env';

const DEMO_BASE = 'https://api.coingecko.com/api/v3';
const PRO_BASE = 'https://pro-api.coingecko.com/api/v3';

const ALLOWED_PATH =
  /^(nfts\/markets|nfts\/list|nfts\/market_chart\/global|nfts\/[a-zA-Z0-9_-]+(?:\/market_chart)?|search\/trending|coins\/markets)(\?.*)?$/;

export interface MarketProxyResult {
  status: number;
  body: unknown;
}

function normalizePath(path: string): string {
  return path.replace(/^\//, '');
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

export class CoinGeckoService {
  static isAllowedPath(path: string): boolean {
    return isAllowedPath(path);
  }

  static async get(path: string): Promise<MarketProxyResult> {
    if (!isAllowedPath(path)) {
      return { status: 400, body: { error: 'Path is not allowlisted' } };
    }

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
    const url = `${base}/${normalizePath(path)}`;

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
}
