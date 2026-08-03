/**
 * Two-stage cutover bootstrap after a membership contract redeploy.
 *
 * Keeps Mongo as-is. Restores on-chain memberships + claim balances on NEW_CONTRACT_ADDRESS.
 *
 * Usage:
 *   # Preview: build snapshot from Mongo + OLD contract, print required funding
 *   npx tsx src/scripts/bootstrap-contract.ts preview
 *
 *   # Stage 1: mint missing mock USDT/USDC to owner if needed, then fundBootstrap
 *   NEW_CONTRACT_ADDRESS=0x... OLD_CONTRACT_ADDRESS=0x... OWNER_PRIVATE_KEY=0x... \
 *     npx tsx src/scripts/bootstrap-contract.ts stage1
 *
 *   # Stage 2: seed memberships + commissions from snapshot, then sealBootstrap
 *   NEW_CONTRACT_ADDRESS=0x... OWNER_PRIVATE_KEY=0x... \
 *     npx tsx src/scripts/bootstrap-contract.ts stage2
 *
 * Env:
 *   OLD_CONTRACT_ADDRESS  — previous membership (source of claim balances)
 *   NEW_CONTRACT_ADDRESS  — freshly deployed membership (defaults to CONTRACT_ADDRESS)
 *   OWNER_PRIVATE_KEY     — deployer/owner key (falls back to PRIVATE_KEY)
 *   BOOTSTRAP_SNAPSHOT    — optional path for snapshot JSON
 *   BOOTSTRAP_BATCH_SIZE  — optional batch size for seed txs (default 50)
 */
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { ethers } from 'ethers';
import { connectDB } from '../config/db';
import User from '../models/User';
import { ENV } from '../config/env';
import { contractABI, mintableErc20ABI } from '../services/contract.service';
import { Tier } from '../constants';

const TIER_TO_UINT: Record<string, number> = {
  [Tier.NONE]: 0,
  [Tier.BRONZE]: 1,
  [Tier.SILVER]: 2,
  [Tier.GOLD]: 3,
  [Tier.PLATINUM]: 4,
  [Tier.DIAMOND]: 5,
};

type MembershipRow = { account: string; tier: number; joinedAt: number };
type CommissionRow = {
  account: string;
  token: string;
  withdrawable: string;
  locked: string;
  lastClaimed: number;
};

type Snapshot = {
  oldContract: string;
  newContract: string;
  usdt: string;
  usdc: string;
  requiredUsdt: string;
  requiredUsdc: string;
  membershipCount: number;
  commissionCount: number;
  memberships: MembershipRow[];
  commissions: CommissionRow[];
  createdAt: string;
};

function snapshotPath(): string {
  return (
    process.env.BOOTSTRAP_SNAPSHOT ||
    path.resolve(__dirname, '../../backups/bootstrap-snapshot.json')
  );
}

function ownerKey(): string {
  const key = process.env.OWNER_PRIVATE_KEY || process.env.PRIVATE_KEY || '';
  if (!key) throw new Error('Set OWNER_PRIVATE_KEY or PRIVATE_KEY');
  return key.startsWith('0x') ? key : `0x${key}`;
}

function newContractAddress(): string {
  return process.env.NEW_CONTRACT_ADDRESS || ENV.CONTRACT_ADDRESS;
}

function oldContractAddress(): string {
  const addr = process.env.OLD_CONTRACT_ADDRESS || '';
  if (!addr) throw new Error('Set OLD_CONTRACT_ADDRESS to the previous membership contract');
  return addr;
}

async function buildSnapshot(): Promise<Snapshot> {
  await connectDB();

  const provider = new ethers.JsonRpcProvider(ENV.RPC_URL);
  const oldAddr = oldContractAddress();
  const newAddr = newContractAddress();
  const old = new ethers.Contract(oldAddr, contractABI, provider);
  const neu = new ethers.Contract(newAddr, contractABI, provider);

  const [usdt, usdc] = await Promise.all([neu.usdt(), neu.usdc()]);

  const members = await User.find({
    tier: { $ne: 'None' },
    walletAddress: { $exists: true, $nin: [null, ''] },
  }).lean();

  const memberships: MembershipRow[] = [];
  const commissions: CommissionRow[] = [];
  let requiredUsdt = BigInt(0);
  let requiredUsdc = BigInt(0);

  for (const u of members) {
    const account = ethers.getAddress(String(u.walletAddress));
    const tier = TIER_TO_UINT[u.tier] ?? 0;
    if (tier === 0) continue;

    const joinedAt = Math.floor(new Date(u.joinedAt).getTime() / 1000) || 1;
    memberships.push({ account, tier, joinedAt });

    for (const token of [usdt, usdc] as string[]) {
      const [withdrawable, locked, lastClaimed] = await Promise.all([
        old.withdrawableCommissions(account, token),
        old.lockedCommissions(account, token),
        old.lastClaimedAt(account, token),
      ]);
      const w = BigInt(withdrawable.toString());
      const l = BigInt(locked.toString());
      const lc = Number(lastClaimed.toString());
      if (w === BigInt(0) && l === BigInt(0) && lc === 0) continue;

      commissions.push({
        account,
        token: ethers.getAddress(token),
        withdrawable: w.toString(),
        locked: l.toString(),
        lastClaimed: lc,
      });

      if (ethers.getAddress(token) === ethers.getAddress(usdt)) requiredUsdt += w;
      else requiredUsdc += w;
    }
  }

  const snap: Snapshot = {
    oldContract: ethers.getAddress(oldAddr),
    newContract: ethers.getAddress(newAddr),
    usdt: ethers.getAddress(usdt),
    usdc: ethers.getAddress(usdc),
    requiredUsdt: requiredUsdt.toString(),
    requiredUsdc: requiredUsdc.toString(),
    membershipCount: memberships.length,
    commissionCount: commissions.length,
    memberships,
    commissions,
    createdAt: new Date().toISOString(),
  };

  const out = snapshotPath();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(snap, null, 2));

  await mongoose.disconnect();
  return snap;
}

function printFunding(snap: Snapshot) {
  console.log('--- Bootstrap snapshot ---');
  console.log(`Saved: ${snapshotPath()}`);
  console.log(`Old contract: ${snap.oldContract}`);
  console.log(`New contract: ${snap.newContract}`);
  console.log(`Members to seed: ${snap.membershipCount}`);
  console.log(`Commission rows: ${snap.commissionCount}`);
  console.log(`Required USDT (raw): ${snap.requiredUsdt}`);
  console.log(`Required USDC (raw): ${snap.requiredUsdc}`);
  console.log('Stage 1 must fundBootstrap at least these amounts before stage 2 seal.');
}

function loadSnapshot(): Snapshot {
  const out = snapshotPath();
  if (!fs.existsSync(out)) {
    throw new Error(`Snapshot missing at ${out}. Run: npx tsx src/scripts/bootstrap-contract.ts preview`);
  }
  return JSON.parse(fs.readFileSync(out, 'utf8')) as Snapshot;
}

async function ensureOwnerTokenBalance(
  token: ethers.Contract,
  label: string,
  owner: string,
  needed: bigint,
) {
  if (needed <= BigInt(0)) return;
  const bal = BigInt((await token.balanceOf(owner)).toString());
  if (bal >= needed) {
    console.log(`${label}: owner already has ${bal} (need ${needed})`);
    return;
  }
  const mintAmt = needed - bal;
  console.log(`${label}: owner has ${bal}, minting ${mintAmt} to cover shortfall`);
  try {
    const tx = await token.mint(owner, mintAmt);
    console.log(`${label} mint tx: ${tx.hash}`);
    await tx.wait();
  } catch (err: any) {
    throw new Error(
      `${label}: owner underfunded (${bal} < ${needed}) and mint() failed: ${err?.shortMessage || err?.message || err}`,
    );
  }
}

async function stage1() {
  const snap = fs.existsSync(snapshotPath()) ? loadSnapshot() : await buildSnapshot();
  printFunding(snap);

  const provider = new ethers.JsonRpcProvider(ENV.RPC_URL);
  const wallet = new ethers.Wallet(ownerKey(), provider);
  const membership = new ethers.Contract(snap.newContract, contractABI, wallet);
  const usdt = new ethers.Contract(snap.usdt, mintableErc20ABI, wallet);
  const usdc = new ethers.Contract(snap.usdc, mintableErc20ABI, wallet);

  const needUsdt = BigInt(snap.requiredUsdt);
  const needUsdc = BigInt(snap.requiredUsdc);
  const balUsdt = BigInt((await usdt.balanceOf(snap.newContract)).toString());
  const balUsdc = BigInt((await usdc.balanceOf(snap.newContract)).toString());

  const fundUsdt = needUsdt > balUsdt ? needUsdt - balUsdt : BigInt(0);
  const fundUsdc = needUsdc > balUsdc ? needUsdc - balUsdc : BigInt(0);

  console.log('--- Stage 1: mint (if needed) + fundBootstrap ---');
  console.log(`Owner: ${wallet.address}`);
  console.log(`USDT to transfer into contract: ${fundUsdt}`);
  console.log(`USDC to transfer into contract: ${fundUsdc}`);

  if (fundUsdt === BigInt(0) && fundUsdc === BigInt(0)) {
    console.log('Contract already funded enough. Skipping transfers.');
    return;
  }

  await ensureOwnerTokenBalance(usdt, 'USDT', wallet.address, fundUsdt);
  await ensureOwnerTokenBalance(usdc, 'USDC', wallet.address, fundUsdc);

  if (fundUsdt > BigInt(0)) {
    const txA = await usdt.approve(snap.newContract, fundUsdt);
    await txA.wait();
    const txF = await membership.fundBootstrap(snap.usdt, fundUsdt);
    console.log(`fundBootstrap USDT tx: ${txF.hash}`);
    await txF.wait();
  }
  if (fundUsdc > BigInt(0)) {
    const txA = await usdc.approve(snap.newContract, fundUsdc);
    await txA.wait();
    const txF = await membership.fundBootstrap(snap.usdc, fundUsdc);
    console.log(`fundBootstrap USDC tx: ${txF.hash}`);
    await txF.wait();
  }

  console.log('Stage 1 done.');
}

async function stage2() {
  const snap = loadSnapshot();
  const batchSize = Number(process.env.BOOTSTRAP_BATCH_SIZE || 50);

  const provider = new ethers.JsonRpcProvider(ENV.RPC_URL);
  const wallet = new ethers.Wallet(ownerKey(), provider);
  const membership = new ethers.Contract(snap.newContract, contractABI, wallet);

  if (await membership.bootstrapClosed()) {
    throw new Error('Bootstrap already sealed on new contract');
  }

  console.log('--- Stage 2: seedMemberships / seedCommissions / sealBootstrap ---');

  for (let i = 0; i < snap.memberships.length; i += batchSize) {
    const chunk = snap.memberships.slice(i, i + batchSize);
    const tx = await membership.seedMemberships(
      chunk.map((m) => m.account),
      chunk.map((m) => m.tier),
      chunk.map((m) => m.joinedAt),
    );
    console.log(`seedMemberships [${i}..${i + chunk.length}): ${tx.hash}`);
    await tx.wait();
  }

  for (let i = 0; i < snap.commissions.length; i += batchSize) {
    const chunk = snap.commissions.slice(i, i + batchSize);
    const tx = await membership.seedCommissions(
      chunk.map((c) => c.account),
      chunk.map((c) => c.token),
      chunk.map((c) => c.withdrawable),
      chunk.map((c) => c.locked),
      chunk.map((c) => c.lastClaimed),
    );
    console.log(`seedCommissions [${i}..${i + chunk.length}): ${tx.hash}`);
    await tx.wait();
  }

  const shortUsdt = BigInt((await membership.fundingShortfall(snap.usdt)).toString());
  const shortUsdc = BigInt((await membership.fundingShortfall(snap.usdc)).toString());
  if (shortUsdt > BigInt(0) || shortUsdc > BigInt(0)) {
    throw new Error(
      `Underfunded before seal. USDT shortfall=${shortUsdt} USDC shortfall=${shortUsdc}. Re-run stage1.`,
    );
  }

  const sealTx = await membership.sealBootstrap();
  console.log(`sealBootstrap: ${sealTx.hash}`);
  await sealTx.wait();
  console.log('Stage 2 done. Bootstrap sealed. Point envs at NEW_CONTRACT_ADDRESS if not already.');
}

async function main() {
  const cmd = (process.argv[2] || 'preview').toLowerCase();
  if (cmd === 'preview') {
    const snap = await buildSnapshot();
    printFunding(snap);
  } else if (cmd === 'stage1') {
    await stage1();
  } else if (cmd === 'stage2') {
    await stage2();
  } else {
    console.error('Usage: bootstrap-contract.ts [preview|stage1|stage2]');
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
