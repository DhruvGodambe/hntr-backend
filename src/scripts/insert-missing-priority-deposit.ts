/**
 * Manually credit a Priority Line deposit whose confirm call never landed, slotting it
 * directly behind a given live position of the same user.
 *
 *   tsx src/scripts/insert-missing-priority-deposit.ts <username> <txHash> <afterPosition> [--apply]
 *
 * Dry-run by default. Verifies the on-chain transfer the same way confirmDeposit does.
 */
import mongoose from 'mongoose';
import { ethers } from 'ethers';
import { connectDB } from '../config/db';
import User from '../models/User';
import AdminSettings from '../models/AdminSettings';
import PriorityLineDeposit, { PriorityLineStatus } from '../models/PriorityLineDeposit';
import Counter from '../models/Counter';
import { NotificationService } from '../services/notification.service';

// The backend .env may point at a testnet RPC; deposits are verified against mainnet here.
const provider = new ethers.JsonRpcProvider(process.env.MAINNET_RPC_URL || 'https://ethereum-rpc.publicnode.com');
const MAINNET_TOKENS: Record<string, 'USDT' | 'USDC'> = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
};
const DECIMALS = 6;

const TRANSFER_IFACE = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const TRANSFER_TOPIC = TRANSFER_IFACE.getEvent('Transfer')!.topicHash;
const COUNTED: PriorityLineStatus[] = ['ACTIVE', 'WITHDRAWAL_REQUESTED'];

async function main() {
  const [username, txHashRaw, afterRaw] = process.argv.slice(2);
  const apply = process.argv.includes('--apply');
  const txHash = String(txHashRaw).toLowerCase();
  const afterPosition = Number(afterRaw);
  if (!username || !/^0x[0-9a-f]{64}$/.test(txHash) || !Number.isInteger(afterPosition)) {
    throw new Error('usage: <username> <txHash> <afterPosition> [--apply]');
  }

  await connectDB();

  const user = await User.findOne({ username: new RegExp(`^${username}$`, 'i') }).select('walletAddress username tier').lean();
  if (!user) throw new Error(`user ${username} not found`);
  const wallet = String(user.walletAddress).toLowerCase();
  console.log(`user: ${user.username} wallet=${wallet} tier=${user.tier}`);

  const existing = await PriorityLineDeposit.find({ txHash }).lean();
  if (existing.length) {
    console.log('tx already recorded:', existing);
    return;
  }

  // ── on-chain verification ─────────────────────────────────────────────
  const settings = await AdminSettings.findOne({ key: 'global' }).lean();
  const accepted = new Set(
    [settings?.priorityLineDepositWallet, ...(settings?.priorityLineWalletHistory ?? [])]
      .filter((a): a is string => !!a)
      .map((a) => a.toLowerCase()),
  );
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt || receipt.status !== 1) throw new Error(`tx not mined or failed (status ${receipt?.status})`);
  const tokens = MAINNET_TOKENS;
  const decimals = DECIMALS;
  const matches = [];
  for (const log of receipt.logs) {
    const token = tokens[log.address.toLowerCase()];
    if (!token || log.topics[0] !== TRANSFER_TOPIC) continue;
    const p = TRANSFER_IFACE.parseLog({ topics: [...log.topics], data: log.data })!;
    const from = String(p.args[0]).toLowerCase();
    const to = String(p.args[1]).toLowerCase();
    const value = p.args[2] as bigint;
    console.log(`  transfer ${token} ${from} → ${to} ${ethers.formatUnits(value, decimals)} (log ${log.index})`);
    if (from === wallet && accepted.has(to)) matches.push({ token, to, value, logIndex: Number(log.index) });
  }
  if (matches.length !== 1) throw new Error(`expected exactly 1 matching transfer, found ${matches.length}`);
  const m = matches[0];
  const amountUsd = Math.round(Number(ethers.formatUnits(m.value, decimals)) * 100) / 100;
  console.log(`verified: ${amountUsd} ${m.token} from ${wallet} to ${m.to}`);

  // ── slot the ticket right behind the given position ───────────────────
  const queueFilter: Record<string, any> = { status: { $in: COUNTED }, lineNumber: { $type: 'number' } };
  const queueRows = await PriorityLineDeposit.find(queueFilter)
    .select('lineNumber walletAddress amountUsd')
    .sort({ lineNumber: 1 })
    .lean();
  const anchor = queueRows[afterPosition - 1];
  if (!anchor) throw new Error(`no deposit at position ${afterPosition} (queue length ${queueRows.length})`);
  if (anchor.walletAddress !== wallet) throw new Error(`position ${afterPosition} belongs to ${anchor.walletAddress}, not ${wallet}`);
  const userPositions = queueRows.map((r, i) => (r.walletAddress === wallet ? i + 1 : null)).filter(Boolean);
  console.log(`user's live positions: ${userPositions.join(', ')}`);
  const ticket = (anchor.lineNumber as number) + 1;
  const toShift = await PriorityLineDeposit.find({ lineNumber: { $gte: ticket } }).sort({ lineNumber: -1 }).select('lineNumber').lean();
  console.log(`new ticket ${ticket} (position #${afterPosition + 1}); ${toShift.length} later tickets shift +1`);

  if (!apply) {
    console.log('dry run — re-run with --apply to insert');
    return;
  }

  // Reserve one extra counter slot, then shift later tickets from the back so the unique index holds.
  await Counter.updateOne({ key: 'priorityLine' }, { $inc: { seq: 1 } });
  for (const r of toShift) {
    await PriorityLineDeposit.updateOne({ _id: r._id, lineNumber: r.lineNumber }, { $set: { lineNumber: (r.lineNumber as number) + 1 } });
  }

  const doc = await PriorityLineDeposit.create({
    walletAddress: wallet,
    lineNumber: ticket,
    token: m.token,
    amountUsd,
    amountRaw: m.value.toString(),
    txHash,
    logIndex: m.logIndex,
    depositWallet: m.to,
    status: 'ACTIVE',
    adminNote: 'Manually credited: deposit confirmation did not reach backend',
  });
  console.log(`created deposit ${doc._id} ticket ${ticket}`);

  await NotificationService.createQuiet({
    walletAddress: wallet,
    type: 'PRIORITY_LINE_DEPOSIT',
    title: `Priority Line spot reserved — #${afterPosition + 1}`,
    sub: `$${amountUsd} ${m.token} deposited`,
    link: '/priority-line',
    meta: { lineNumber: afterPosition + 1, amountUsd, token: m.token, txHash },
    dedupeKey: `PRIORITY_LINE_DEPOSIT:${txHash}:${m.logIndex}`,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
