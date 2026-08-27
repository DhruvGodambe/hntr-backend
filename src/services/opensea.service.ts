import { ENV } from '../config/env';

const OPENSEA_API_BASE = 'https://api.opensea.io/api/v2';

const SLUG = '[a-zA-Z0-9_-]+';
const CHAIN = '[a-z0-9-]+';
const ADDR = '0x[a-fA-F0-9]{40}';
const TOKEN = '[a-zA-Z0-9_-]+';

const GET_ALLOWED = new RegExp(
  `^(?:` +
    `collections/${SLUG}` +
    `|collections/${SLUG}/stats` +
    `|collection/${SLUG}/nfts` +
    `|events/collection/${SLUG}` +
    `|listings/collection/${SLUG}/best` +
    `|chain/${CHAIN}/contract/${ADDR}/nfts/${TOKEN}` +
    `)(?:\\?.*)?$`,
);

const POST_ALLOWED = /^nfts\/batch(?:\?.*)?$/;

export interface MarketProxyResult {
  status: number;
  body: unknown;
}

function normalizePath(path: string): string {
  return path.replace(/^\//, '');
}

function isAllowedPath(path: string, method: string): boolean {
  const normalized = normalizePath(path);
  if (normalized.includes('..')) return false;
  if (method === 'POST') return POST_ALLOWED.test(normalized);
  return GET_ALLOWED.test(normalized);
}

function getApiKey(): string {
  const key = ENV.OPENSEA_API_KEY.replace(/^["']|["']$/g, '').trim();
  if (!key) throw new Error('OpenSea API key not configured');
  return key;
}

export class OpenSeaService {
  static isAllowedPath(path: string, method: string): boolean {
    return isAllowedPath(path, method);
  }

  static async proxy(method: 'GET' | 'POST', path: string, body?: string): Promise<MarketProxyResult> {
    if (!isAllowedPath(path, method)) {
      return { status: 400, body: { error: 'Path is not allowlisted' } };
    }

    let apiKey: string;
    try {
      apiKey = getApiKey();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'OpenSea API key not configured';
      return { status: 500, body: { error: message } };
    }

    const url = `${OPENSEA_API_BASE}/${normalizePath(path)}`;

    try {
      const res = await fetch(url, {
        method,
        headers: {
          'X-API-KEY': apiKey,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body } : {}),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return {
          status: res.status,
          body: {
            error: `OpenSea API error: ${res.status} ${res.statusText}`,
            details: text.slice(0, 500),
          },
        };
      }

      return { status: 200, body: await res.json() };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return {
        status: 502,
        body: { error: 'Failed to fetch from OpenSea', details: message },
      };
    }
  }
}
