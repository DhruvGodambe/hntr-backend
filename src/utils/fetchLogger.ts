import { logUpstream, logUpstreamError } from './httpLog';

const SENSITIVE_QUERY = /key|token|secret|auth|password|signature/i;

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const name of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY.test(name)) url.searchParams.set(name, 'REDACTED');
    }
    return url.toString();
  } catch {
    return raw.replace(/((?:api)?[_-]?key|token|secret)=([^&]*)/gi, '$1=REDACTED');
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const fromInit = init?.method;
  const fromInput = typeof input !== 'string' && !(input instanceof URL) ? input.method : undefined;
  return (fromInit || fromInput || 'GET').toUpperCase();
}

/**
 * Wraps global fetch so every outbound HTTP call logs a coloured UPSTREAM line:
 * host, path, status chip, duration, and a body snippet on non-2xx.
 */
export function installFetchLogger(): void {
  const nativeFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = redactUrl(requestUrl(input));
    const method = requestMethod(input, init);
    const started = Date.now();

    try {
      const res = await nativeFetch(input, init);
      const ms = Date.now() - started;

      let snippet = '';
      if (!res.ok) {
        try {
          snippet = (await res.clone().text()).replace(/\s+/g, ' ').slice(0, 300);
        } catch {
          snippet = '';
        }
      }

      logUpstream(method, url, res.status, ms, res.statusText, snippet);
      return res;
    } catch (err: unknown) {
      const ms = Date.now() - started;
      const message = err instanceof Error ? err.message : String(err);
      logUpstreamError(method, url, ms, message);
      throw err;
    }
  }) as typeof fetch;
}
