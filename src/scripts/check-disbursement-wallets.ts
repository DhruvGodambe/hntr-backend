/**
 * Ops check: protocol + burner ETH for two-hop payouts.
 *   npx tsx src/scripts/check-disbursement-wallets.ts
 */
import { ethers } from 'ethers';
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import { ENV } from '../config/env';
import { hntrContract, provider, burnerWallet } from '../services/contract.service';

async function main() {
  await connectDB();
  const [lead, rank] = await Promise.all([
    hntrContract.leadershipWallet(),
    hntrContract.rankWallet(),
  ]);
  const burner = burnerWallet?.address || ENV.BURNER_WALLET || '';
  const [leadEth, rankEth, burnerEth] = await Promise.all([
    provider.getBalance(String(lead)),
    provider.getBalance(String(rank)),
    burner ? provider.getBalance(burner) : Promise.resolve(BigInt(0)),
  ]);

  // The admin funds the burner by connecting the leadership/rank wallet and
  // transferring USDT/USDC to it; the backend only holds the burner key.
  const report = {
    leadership: String(lead),
    leadershipEth: ethers.formatEther(leadEth),
    rank: String(rank),
    rankEth: ethers.formatEther(rankEth),
    burner: burner || null,
    burnerEth: ethers.formatEther(burnerEth),
    burnerKeySet: Boolean(ENV.BURNER_WALLET_PRIVATE_KEY),
    needsBurnerEth: burnerEth < ethers.parseEther(String(ENV.BURNER_MIN_ETH || 0.02)),
  };
  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
