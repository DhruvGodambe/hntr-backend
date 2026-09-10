import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

/**
 * Load local .env files for development only.
 * On Render/production, secrets must come from the process environment — dotenv
 * must never blank them out. dotenv's default is override:false, but we still
 * skip file loads in production so a committed/empty .env cannot confuse ops.
 */
function loadDotenvFiles() {
  const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
  if (isProd) return;

  const hntrEnv = path.resolve(__dirname, '../../../../hntr/.env');
  if (fs.existsSync(hntrEnv)) {
    dotenv.config({ path: hntrEnv });
  }
  dotenv.config();
}

loadDotenvFiles();

/** Trim + strip wrapping quotes (common when pasting into Render / .env editors). */
function readEnv(name: string, fallback = ''): string {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return String(raw)
    .trim()
    .replace(/^["']|["']$/g, '');
}

export const ENV = {
  PORT: process.env.PORT || 8000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  MONGO_URI: process.env.MONGO_URI || 'mongodb://localhost:27017/hntr',
  RPC_URL: process.env.RPC_URL || process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
  CONTRACT_ADDRESS: process.env.CONTRACT_ADDRESS || '0x40c442AD0fB9545EaECb629572741eb65Bf484A4',
  USDT_ADDRESS: process.env.USDT_ADDRESS || '0xff26Bf42e258979e307B581F32A7C984BCEDA66a',
  USDC_ADDRESS: process.env.USDC_ADDRESS || '0x1A1Bf3C12dc85219D2422dd9B936c5845Be899A1',
  JWT_SECRET: process.env.JWT_SECRET || 'dev-insecure-secret-change-me',
  AUTH_TOKEN_TTL_SECONDS: Number(process.env.AUTH_TOKEN_TTL_SECONDS || 60 * 60 * 24), // 24h
  AUTH_NONCE_TTL_SECONDS: Number(process.env.AUTH_NONCE_TTL_SECONDS || 5 * 60), // 5 min
  // Etherscan (v2 unified API) is used instead of raw eth_getLogs for historical event
  // queries - most public RPC nodes (e.g. publicnode) reject eth_getLogs over any
  // non-trivial block range with "Archive requests require a personal token".
  ETHERSCAN_API_KEY: readEnv('ETHERSCAN_API_KEY'),
  ETHERSCAN_CHAIN_ID: Number(readEnv('ETHERSCAN_CHAIN_ID', '11155111')), // Sepolia
  // Market data proxies. Keys stay on the server; the Next app calls /api/market/*.
  // CoinGecko Demo keys start with "CG-" (api.coingecko.com). Pro keys use pro-api.coingecko.com.
  COINGECKO_API_KEY: process.env.COINGECKO_API_KEY || '',
  // How long successful CoinGecko proxy responses stay fresh in Mongo before a refresh.
  // Concurrent clients within this window read from DB instead of hitting CoinGecko.
  COINGECKO_CACHE_TTL_MS: Number(process.env.COINGECKO_CACHE_TTL_MS || 120_000),
  OPENSEA_API_KEY: process.env.OPENSEA_API_KEY || '',
  CONTRACT_DEPLOY_BLOCK: Number(process.env.CONTRACT_DEPLOY_BLOCK || 11666520),
  // Protocol wallets (treasury/leadership/…) keep the same address across membership
  // redeploys. Admin wallet ledgers scan ERC20 Transfer history from this block
  // (defaults to 0) so prior-contract inflows are not truncated when CONTRACT_DEPLOY_BLOCK
  // is bumped to the latest membership deploy.
  LEDGER_FROM_BLOCK: Number(readEnv('LEDGER_FROM_BLOCK', '0')),
  // Private key that controls `leadershipWallet` on-chain - the only wallet that can
  // pay out the monthly leadership pool, since it holds that pool's actual token balance.
  LEADERSHIP_PRIVATE_KEY: readEnv('LEADERSHIP_PRIVATE_KEY'),
  // Private key that controls `achievementWallet` on-chain - used by the daily cron to
  // auto-deposit one-time rank achievement bonuses when the wallet is funded enough.
  ACHIEVEMENT_WALLET_PRIVATE_KEY: readEnv('ACHIEVEMENT_WALLET_PRIVATE_KEY'),
  // Private key that controls `companyWallet` on-chain. Required for the backend to:
  // - sign purchase/upgrade commission-auth payloads (uplines + ranks)
  // - call `getOverdueWallets()` / `withdrawCompanyWallet()` for overdue users
  COMPANY_WALLET_PRIVATE_KEY: process.env.COMPANY_WALLET_PRIVATE_KEY || '',
  // Private key that controls `burnerWallet` on-chain - the hot key that submits
  // voucher redemptions (`redeemVoucher`) so the redeemer never signs a tx or pays
  // gas. Holds ETH only; must NEVER hold tokens and is deliberately not a commission
  // signer. Voucher redemption is disabled when this is unset.
  BURNER_WALLET_PRIVATE_KEY: process.env.BURNER_WALLET_PRIVATE_KEY || '',
  // Expected burner address, checked against on-chain `burnerWallet()` at startup.
  BURNER_WALLET: process.env.BURNER_WALLET || '',
  // Alert threshold (in ETH) for the burner gas balance; the voucher cron warns below this.
  BURNER_MIN_ETH: Number(process.env.BURNER_MIN_ETH || 0.02),
  // How long a voucher may sit in REDEEMING before the cron sweeps it back to ACTIVE.
  VOUCHER_REDEEM_LOCK_TTL_MS: Number(process.env.VOUCHER_REDEEM_LOCK_TTL_MS || 10 * 60 * 1000),
  // HMAC pepper for the voucher-code lookup hash. Rotating it invalidates every
  // outstanding code, so treat it as fixed for the life of a deployment.
  VOUCHER_CODE_PEPPER: process.env.VOUCHER_CODE_PEPPER || '',
  // AES-256-GCM key (hex or base64, 32 bytes) for encrypting voucher plaintext at rest.
  VOUCHER_CODE_ENC_KEY: process.env.VOUCHER_CODE_ENC_KEY || '',
  // Public base URL of the Next.js app, used to build shareable redeem links.
  APP_BASE_URL: process.env.APP_BASE_URL || 'http://localhost:3000',
  // Shared secret required (via `x-admin-secret` header) to hit protected /api/admin
  // routes that move real funds (e.g. manually triggering the leadership payout run).
  // Left empty by default, which makes those routes always reject.
  ADMIN_SECRET: readEnv('ADMIN_SECRET'),
  // Password for the admin panel web UI (POST /api/admin/auth/login).
  // Legacy fallback when username is omitted. DB-backed admin accounts are preferred.
  ADMIN_PASSWORD: readEnv('ADMIN_PASSWORD'),
  // When not "false", enables DB-backed admin username/password auth.
  ADMIN_DB_AUTH: readEnv('ADMIN_DB_AUTH', 'true'),
  // Required to create additional admin accounts after the first bootstrap account.
  ADMIN_SETUP_SECRET: readEnv('ADMIN_SETUP_SECRET'),
  ADMIN_TOKEN_TTL_SECONDS: Number(readEnv('ADMIN_TOKEN_TTL_SECONDS', '3600')),
  // Cloudflare Turnstile secret key for the "Verify you are human" widget on
  // login / register. When empty, the server-side check is skipped (dev/Postman).
  // Get it from Cloudflare dashboard -> Turnstile -> your widget -> Secret Key.
  TURNSTILE_SECRET: readEnv('TURNSTILE_SECRET'),

  // Gift-code crypto + redeem links. REQUIRED for issue/reveal/redeem URL building.
  // Pepper: any long random string. Enc key: 32-byte key as hex (64 chars) or base64.
};

/** Non-secret startup check — logs whether voucher crypto env is present. */
export function logVoucherEnvStatus() {
  const pepper = Boolean(ENV.VOUCHER_CODE_PEPPER);
  const encKey = Boolean(ENV.VOUCHER_CODE_ENC_KEY);
  console.log(
    `[ENV] voucher secrets: VOUCHER_CODE_PEPPER=${pepper ? 'set' : 'MISSING'} ` +
      `VOUCHER_CODE_ENC_KEY=${encKey ? 'set' : 'MISSING'} ` +
      `(NODE_ENV=${ENV.NODE_ENV})`,
  );
  if (!pepper || !encKey) {
    console.warn(
      '[ENV] Gift-code issue/reveal will fail until both vars are set on the backend Render service ' +
        'and the service is redeployed. Exact names: VOUCHER_CODE_PEPPER, VOUCHER_CODE_ENC_KEY.',
    );
  }
}
