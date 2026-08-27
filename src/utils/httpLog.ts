const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

const FG = {
  black: '\x1b[30m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightYellow: '\x1b[93m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
};

const BG = {
  red: '\x1b[41m',
  green: '\x1b[42m',
  yellow: '\x1b[43m',
  blue: '\x1b[44m',
  magenta: '\x1b[45m',
  cyan: '\x1b[46m',
};

const useColor =
  process.env.NO_COLOR !== '1' &&
  process.env.FORCE_COLOR !== '0' &&
  (process.stdout.isTTY || process.env.FORCE_COLOR === '1');

function paint(codes: string, text: string): string {
  if (!useColor) return text;
  return `${codes}${text}${RESET}`;
}

function clock(): string {
  return paint(DIM + FG.gray, new Date().toISOString().slice(11, 23));
}

function methodColor(method: string): string {
  switch (method) {
    case 'GET':
      return paint(BOLD + FG.brightCyan, method.padEnd(6));
    case 'POST':
      return paint(BOLD + FG.brightMagenta, method.padEnd(6));
    case 'PUT':
    case 'PATCH':
      return paint(BOLD + FG.brightYellow, method.padEnd(6));
    case 'DELETE':
      return paint(BOLD + FG.brightRed, method.padEnd(6));
    default:
      return paint(BOLD + FG.white, method.padEnd(6));
  }
}

function statusStyle(status: number): { codes: string; label: string } {
  if (status >= 500) return { codes: BOLD + BG.red + FG.white, label: 'ERR' };
  if (status >= 400) return { codes: BOLD + BG.yellow + FG.black, label: 'FAIL' };
  if (status >= 300) return { codes: BOLD + BG.cyan + FG.black, label: 'REDIR' };
  if (status >= 200) return { codes: BOLD + BG.green + FG.black, label: 'OK' };
  return { codes: BOLD + FG.white, label: '' };
}

function statusBadge(status: number, statusText = ''): string {
  const { codes, label } = statusStyle(status);
  const text = statusText ? ` ${status} ${statusText} ` : ` ${status} `;
  const chip = paint(codes, text);
  const tag = label ? ` ${paint(DIM + FG.gray, label)}` : '';
  return `${chip}${tag}`;
}

function duration(ms: number): string {
  const text = `${ms}ms`.padStart(7);
  if (ms >= 2000) return paint(BOLD + FG.brightRed, text);
  if (ms >= 800) return paint(FG.brightYellow, text);
  return paint(DIM + FG.gray, text);
}

function truncate(value: string, max = 88): string {
  if (value.length <= max) return value;
  return `${value.slice(0, 28)}…${value.slice(-(max - 29))}`;
}

function inboundBadge(): string {
  return paint(BOLD + BG.blue + FG.white, ' INBOUND  ');
}

function upstreamBadge(): string {
  return paint(BOLD + BG.magenta + FG.white, ' UPSTREAM ');
}

function failBadge(): string {
  return paint(BOLD + BG.red + FG.white, ' UPSTREAM ');
}

export function logInbound(method: string, url: string, status: number, ms: number, ip: string): void {
  const line = [
    clock(),
    inboundBadge(),
    methodColor(method),
    paint(FG.brightCyan, truncate(url)),
    paint(DIM + FG.gray, '→'),
    statusBadge(status),
    duration(ms),
    paint(DIM + FG.gray, ip),
  ].join(' ');

  if (status >= 500) console.error(line);
  else if (status >= 400) console.warn(line);
  else console.log(line);
}

export function logUpstream(
  method: string,
  url: string,
  status: number,
  ms: number,
  statusText = '',
  bodySnippet = '',
): void {
  let host = url;
  let path = '';
  try {
    const parsed = new URL(url);
    host = parsed.host.replace(/^www\./, '');
    path = parsed.pathname + parsed.search;
  } catch {
    path = '';
  }

  const target = path
    ? `${paint(BOLD + FG.brightMagenta, host)} ${paint(FG.magenta, truncate(path, 72))}`
    : paint(FG.magenta, truncate(url));

  const line = [
    clock(),
    upstreamBadge(),
    methodColor(method),
    target,
    paint(DIM + FG.gray, '→'),
    statusBadge(status, statusText),
    duration(ms),
  ].join(' ');

  if (status >= 400) {
    console.warn(line);
    if (bodySnippet) {
      console.warn(`            ${paint(DIM + FG.yellow, `↳ ${bodySnippet}`)}`);
    }
  } else {
    console.log(line);
  }
}

export function logUpstreamError(method: string, url: string, ms: number, message: string): void {
  console.error(
    [
      clock(),
      failBadge(),
      methodColor(method),
      paint(FG.brightRed, truncate(url)),
      paint(DIM + FG.gray, '→'),
      paint(BOLD + BG.red + FG.white, ' FAILED '),
      duration(ms),
    ].join(' '),
  );
  console.error(`            ${paint(DIM + FG.red, `↳ ${message}`)}`);
}
