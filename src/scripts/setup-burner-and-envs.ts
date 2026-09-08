/**
 * Phase-2 ops helper:
 *  1. Generate a burner wallet (or reuse generated-burner.env)
 *  2. Fund it with ETH from hntr/.env PRIVATE_KEY (default 0.5 ETH)
 *  3. Ensure voucher crypto secrets exist in hntr-backend/.env
 *  4. Write BURNER_WALLET(+_PRIVATE_KEY) into hntr/.env and hntr-backend/.env
 *
 * Usage:
 *   npx tsx src/scripts/setup-burner-and-envs.ts
 *   FUND_ETH=0.5 npx tsx src/scripts/setup-burner-and-envs.ts
 *   SKIP_FUND=1 npx tsx src/scripts/setup-burner-and-envs.ts
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { ethers } from 'ethers';
import { generateBurnerWallet } from '../services/wallet.service';

const HNTR_ENV = path.resolve(__dirname, '../../../hntr/.env');
const BACKEND_ENV = path.resolve(__dirname, '../../.env');
const BURNER_FILE = path.resolve(__dirname, '../../generated-burner.env');

dotenv.config({ path: HNTR_ENV });
dotenv.config({ path: BACKEND_ENV, override: true });

function upsertEnv(filePath: string, updates: Record<string, string>) {
  let text = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  if (text && !text.endsWith('\n')) text += '\n';

  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) {
      text = text.replace(re, line);
    } else {
      text += `${line}\n`;
    }
  }

  fs.writeFileSync(filePath, text, { encoding: 'utf8', mode: 0o600 });
}

function readExistingBurner(): { address: string; privateKey: string } | null {
  if (!fs.existsSync(BURNER_FILE)) return null;
  const parsed = dotenv.parse(fs.readFileSync(BURNER_FILE));
  if (parsed.BURNER_WALLET && parsed.BURNER_WALLET_PRIVATE_KEY) {
    return {
      address: parsed.BURNER_WALLET,
      privateKey: parsed.BURNER_WALLET_PRIVATE_KEY,
    };
  }
  return null;
}

async function main() {
  const existing = readExistingBurner();
  const burner = existing ?? generateBurnerWallet();
  console.log(`Burner address: ${burner.address}`);

  const pepper =
    process.env.VOUCHER_CODE_PEPPER || crypto.randomBytes(32).toString('hex');
  const encKey =
    process.env.VOUCHER_CODE_ENC_KEY || crypto.randomBytes(32).toString('hex');
  const appBaseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
  const burnerMinEth = process.env.BURNER_MIN_ETH || '0.02';

  upsertEnv(HNTR_ENV, {
    BURNER_WALLET: burner.address,
  });

  upsertEnv(BACKEND_ENV, {
    BURNER_WALLET: burner.address,
    BURNER_WALLET_PRIVATE_KEY: burner.privateKey,
    VOUCHER_CODE_PEPPER: pepper,
    VOUCHER_CODE_ENC_KEY: encKey,
    APP_BASE_URL: appBaseUrl,
    BURNER_MIN_ETH: burnerMinEth,
    VOUCHER_REDEEM_LOCK_TTL_MS: process.env.VOUCHER_REDEEM_LOCK_TTL_MS || '600000',
  });

  console.log('Wrote burner + voucher secrets into hntr/.env and hntr-backend/.env');

  if (process.env.SKIP_FUND === '1') {
    console.log('SKIP_FUND=1 — not sending ETH.');
    return;
  }

  const funderKey = process.env.PRIVATE_KEY || process.env.OWNER_PRIVATE_KEY;
  if (!funderKey) {
    throw new Error('PRIVATE_KEY (or OWNER_PRIVATE_KEY) missing — cannot fund burner');
  }

  const rpc = process.env.SEPOLIA_RPC_URL || process.env.RPC_URL;
  if (!rpc) throw new Error('SEPOLIA_RPC_URL / RPC_URL missing');

  const amountEth = process.env.FUND_ETH || '0.5';
  const provider = new ethers.JsonRpcProvider(rpc);
  const funder = new ethers.Wallet(
    funderKey.startsWith('0x') ? funderKey : `0x${funderKey}`,
    provider,
  );

  const funderBal = await provider.getBalance(funder.address);
  const value = ethers.parseEther(amountEth);
  console.log(`Funder: ${funder.address}`);
  console.log(`Funder balance: ${ethers.formatEther(funderBal)} ETH`);
  console.log(`Sending ${amountEth} ETH -> ${burner.address}`);

  if (funderBal <= value) {
    throw new Error(
      `Funder balance ${ethers.formatEther(funderBal)} ETH is insufficient for ${amountEth} ETH (+ gas)`,
    );
  }

  const burnerBefore = await provider.getBalance(burner.address);
  const tx = await funder.sendTransaction({ to: burner.address, value });
  console.log(`Fund tx: ${tx.hash}`);
  await tx.wait(1);
  const burnerAfter = await provider.getBalance(burner.address);
  console.log(
    `Burner funded: ${ethers.formatEther(burnerBefore)} -> ${ethers.formatEther(burnerAfter)} ETH`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
