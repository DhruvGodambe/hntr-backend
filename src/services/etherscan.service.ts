import { ENV } from '../config/env';

/**
 * Historical event logs via the Etherscan v2 unified API, instead of raw
 * `eth_getLogs` against the RPC node.
 *
 * Most public RPC endpoints (publicnode, etc.) only keep a small recent
 * window of state available for free and reject `eth_getLogs` over anything
 * older with "Archive requests require a personal token". Etherscan indexes
 * full chain history itself, so querying its Event Log API side-steps that
 * limit entirely and lets us scan from the contract's deploy block onward.
 *
 * Docs: https://docs.etherscan.io/api-reference/endpoint/getlogs-address-topics
 */

export interface EtherscanLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  timeStamp: number;
  transactionHash: string;
  logIndex: number;
}

interface RawEtherscanLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  timeStamp: string;
  transactionHash: string;
  logIndex: string;
}

const ETHERSCAN_BASE_URL = 'https://api.etherscan.io/v2/api';
const MAX_PAGES = 5; // 5 * 1000 = 5000 logs per query, generous for this app's scale

function toNumber(hexOrDec: string): number {
  if (!hexOrDec) return 0;
  return hexOrDec.startsWith('0x') ? parseInt(hexOrDec, 16) : Number(hexOrDec);
}

/**
 * Etherscan's free-tier API key caps requests at 3/sec across the *entire* key
 * (not per-endpoint) - the network page alone fires 4-5 of these per load
 * (one per event type + one for lifetime commissions), so calling them all via
 * `Promise.all` reliably tripped "Max calls per sec rate limit reached (3/sec)".
 * This serializes every outbound Etherscan request through a single queue with
 * a minimum gap between dispatches, regardless of how many callers are waiting
 * on it concurrently (including from multiple users' dashboards at once).
 */
const MIN_REQUEST_GAP_MS = 400; // ~2.5 req/sec, safely under the 3/sec cap
let requestQueue: Promise<void> = Promise.resolve();
let lastDispatchAt = 0;

function throttledFetch(url: string): Promise<Response> {
  const runNext = requestQueue.then(async () => {
    const waitMs = Math.max(0, lastDispatchAt + MIN_REQUEST_GAP_MS - Date.now());
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastDispatchAt = Date.now();
  });
  requestQueue = runNext.catch(() => undefined);
  return runNext.then(() => fetch(url));
}

function isRateLimitMessage(message: unknown): boolean {
  return typeof message === 'string' && message.toLowerCase().includes('rate limit');
}

export interface GetLogsParams {
  address: string;
  /** topics[0] = event signature, topics[1] = indexed arg (e.g. padded wallet address), etc. Use undefined to skip a slot. */
  topics: (string | undefined)[];
  fromBlock: number;
  toBlock?: number | 'latest';
}

/**
 * Fetches logs for a single event signature (+ optional indexed topics),
 * paginating through Etherscan's 1000-result-per-page cap as needed.
 * Returns an empty array (with a console warning) on any failure so callers
 * can degrade gracefully instead of throwing.
 */
export async function getLogsViaEtherscan({ address, topics, fromBlock, toBlock = 'latest' }: GetLogsParams): Promise<EtherscanLog[]> {
  if (!ENV.ETHERSCAN_API_KEY) {
    console.warn('ETHERSCAN_API_KEY is not set - cannot fetch historical logs via Etherscan.');
    return [];
  }

  const definedTopics = topics
    .map((t, i) => [i, t] as const)
    .filter(([, t]) => t !== undefined) as [number, string][];

  const results: EtherscanLog[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      chainid: String(ENV.ETHERSCAN_CHAIN_ID),
      module: 'logs',
      action: 'getLogs',
      address,
      fromBlock: String(fromBlock),
      toBlock: String(toBlock),
      page: String(page),
      offset: '1000',
      apikey: ENV.ETHERSCAN_API_KEY,
    });
    for (const [i, topic] of definedTopics) {
      params.set(`topic${i}`, topic);
    }
    // Etherscan requires an explicit AND/OR operator whenever two topic slots are set.
    for (let i = 0; i < definedTopics.length - 1; i++) {
      const [a] = definedTopics[i];
      const [b] = definedTopics[i + 1];
      params.set(`topic${a}_${b}_opr`, 'and');
    }

    const url = `${ETHERSCAN_BASE_URL}?${params.toString()}`;
    let json: any;
    const MAX_RATE_LIMIT_RETRIES = 3;
    let attempt = 0;
    while (true) {
      try {
        const res = await throttledFetch(url);
        json = await res.json();
      } catch (e: any) {
        console.warn(`Etherscan getLogs request failed for ${address}:`, e.message);
        return results;
      }

      if (isRateLimitMessage(json.message) && attempt < MAX_RATE_LIMIT_RETRIES) {
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_GAP_MS * attempt));
        continue;
      }
      break;
    }

    // Etherscan returns status "0" with message "No records found" for empty results,
    // which is a normal, expected case (not an error) — don't warn for that one.
    if (json.status !== '1') {
      if (json.message !== 'No records found') {
        console.warn(`Etherscan getLogs returned an error for ${address}:`, json.message, json.result ?? '');
      }
      break;
    }

    const rawLogs: RawEtherscanLog[] = Array.isArray(json.result) ? json.result : [];
    for (const log of rawLogs) {
      results.push({
        address: log.address,
        topics: log.topics,
        data: log.data,
        blockNumber: toNumber(log.blockNumber),
        timeStamp: toNumber(log.timeStamp),
        transactionHash: log.transactionHash,
        logIndex: toNumber(log.logIndex),
      });
    }

    if (rawLogs.length < 1000) break; // last page
  }

  return results;
}
