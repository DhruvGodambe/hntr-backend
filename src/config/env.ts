import dotenv from 'dotenv';
import path from 'path';

// Load the root hntr workspace .env
dotenv.config({ path: path.resolve(__dirname, '../../../../hntr/.env') });
// Also load the local .env as fallback/overrides
dotenv.config();

export const ENV = {
  PORT: process.env.PORT || 8000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  MONGO_URI: process.env.MONGO_URI || 'mongodb://localhost:27017/hntr',
  RPC_URL: process.env.RPC_URL || process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
  CONTRACT_ADDRESS: process.env.CONTRACT_ADDRESS || '0xd0930a746470f8555b18B7afdf118FAd05A71a00',
  USDT_ADDRESS: process.env.USDT_ADDRESS || '',
  USDC_ADDRESS: process.env.USDC_ADDRESS || '',
  JWT_SECRET: process.env.JWT_SECRET || 'dev-insecure-secret-change-me',
  AUTH_TOKEN_TTL_SECONDS: Number(process.env.AUTH_TOKEN_TTL_SECONDS || 60 * 60 * 24), // 24h
  AUTH_NONCE_TTL_SECONDS: Number(process.env.AUTH_NONCE_TTL_SECONDS || 5 * 60), // 5 min
  // Etherscan (v2 unified API) is used instead of raw eth_getLogs for historical event
  // queries - most public RPC nodes (e.g. publicnode) reject eth_getLogs over any
  // non-trivial block range with "Archive requests require a personal token".
  ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY || '',
  ETHERSCAN_CHAIN_ID: Number(process.env.ETHERSCAN_CHAIN_ID || 11155111), // Sepolia
  CONTRACT_DEPLOY_BLOCK: Number(process.env.CONTRACT_DEPLOY_BLOCK || 0),
  // Private key that controls `leadershipWallet` on-chain - the only wallet that can
  // pay out the monthly leadership pool, since it holds that pool's actual token balance.
  LEADERSHIP_PRIVATE_KEY: process.env.LEADERSHIP_PRIVATE_KEY || '',
  // Private key that controls `achievementWallet` on-chain - used by the daily cron to
  // auto-deposit one-time rank achievement bonuses when the wallet is funded enough.
  ACHIEVEMENT_WALLET_PRIVATE_KEY: process.env.ACHIEVEMENT_WALLET_PRIVATE_KEY || '',
  // Private key that controls `companyWallet` on-chain. Required for the backend to:
  // - sign purchase/upgrade commission-auth payloads (uplines + ranks)
  // - call `getOverdueWallets()` / `withdrawCompanyWallet()` for overdue users
  COMPANY_WALLET_PRIVATE_KEY: process.env.COMPANY_WALLET_PRIVATE_KEY || '',
  // Shared secret required (via `x-admin-secret` header) to hit protected /api/admin
  // routes that move real funds (e.g. manually triggering the leadership payout run).
  // Left empty by default, which makes those routes always reject.
  ADMIN_SECRET: process.env.ADMIN_SECRET || '',
};
