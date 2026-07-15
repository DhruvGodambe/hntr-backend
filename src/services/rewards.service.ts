import User from '../models/User';
import Payout, { IPayoutBreakdownEntry } from '../models/Payout';
import { ethers } from 'ethers';
import { hntrContract, provider, getErc20 } from './contract.service';
import { ENV } from '../config/env';

export class RewardsService {
  /**
   * Generates a report for users who achieved a new rank recently.
   * In a real system, you might track "RankUpgraded" events or timestamps in the DB.
   */
  static async generateRankBonusReport() {
    // For demonstration, we just fetch all users with ranks >= Hunter
    const eligibleUsers = await User.find({ rank: { $in: ['Scout', 'Tracker', 'Ranger', 'Hunter', 'Elite Hunter', 'Master Hunter', 'Legend Hunter'] } });
    
    // Typically, you'd filter by those who upgraded in the last 24h.
    // Assuming each rank has a fixed bonus
    const rankBonuses = {
      'Scout': 25,
      'Tracker': 150,
      'Ranger': 750,
      'Hunter': 5000,
      'Elite Hunter': 25000,
      'Master Hunter': 100000,
      'Legend Hunter': 500000
    };

    const report = eligibleUsers.map(u => ({
      username: u.username,
      walletAddress: u.walletAddress,
      rank: u.rank,
      bonusAmount: rankBonuses[u.rank as keyof typeof rankBonuses] || 0
    }));

    return report;
  }

  /**
   * Calculates the monthly leadership pool distribution based on live on-chain balances,
   * and pays each eligible user's share directly to their wallet (a real ERC20
   * `transfer`, not a claimable contract balance - leadership bonus is auto-deposited,
   * no "claim" step needed).
   *
   * The pool can be funded in either supported stablecoin (HNTRMembership.sol routes
   * 5% of every purchase/upgrade to `leadershipWallet` in whichever token the buyer
   * paid with), and decimals are read live from each token rather than assumed, since
   * the mock USDT/USDC used on this deployment use 18 decimals, not the usual 6.
   */
  static async calculateMonthlyLeadershipPool() {
    const [usdtAddress, usdcAddress, leadershipWallet] = await Promise.all([
      hntrContract.usdt(),
      hntrContract.usdc(),
      hntrContract.leadershipWallet(),
    ]);

    const tokenPools = await Promise.all(
      ([
        { symbol: 'USDT', address: usdtAddress },
        { symbol: 'USDC', address: usdcAddress },
      ] as const).map(async ({ symbol, address }) => {
        const erc20 = getErc20(address);
        const [rawBalance, decimals] = await Promise.all([
          erc20.balanceOf(leadershipWallet),
          erc20.decimals().catch(() => 6),
        ]);
        const decimalsNum = Number(decimals);
        return { symbol, address, decimals: decimalsNum, balance: Number(ethers.formatUnits(rawBalance, decimalsNum)) };
      }),
    );

    tokenPools.forEach((p) => console.log(`Live Leadership Pool Balance: $${p.balance} ${p.symbol}`));

    // 2. Fetch eligible users from DB
    const eligibleUsers = await User.find({ rank: { $in: ['Hunter', 'Elite Hunter', 'Master Hunter', 'Legend Hunter'] } });

    const sharesMap = {
      'Hunter': 1,
      'Elite Hunter': 3,
      'Master Hunter': 7,
      'Legend Hunter': 15
    };

    let totalShares = 0;

    const userShares = eligibleUsers.map(u => {
      const shares = sharesMap[u.rank as keyof typeof sharesMap] || 0;
      totalShares += shares;
      return {
        username: u.username,
        walletAddress: u.walletAddress,
        rank: u.rank,
        shares
      };
    });

    if (totalShares === 0) return [];

    // 3. Set up the wallet that actually controls leadershipWallet's on-chain balance.
    if (!ENV.LEADERSHIP_PRIVATE_KEY) {
      throw new Error('LEADERSHIP_PRIVATE_KEY not found in environment for automated payouts!');
    }
    const adminWallet = new ethers.Wallet(ENV.LEADERSHIP_PRIVATE_KEY, provider);

    // Generate the current month string (YYYY-MM)
    const currentMonth = new Date().toISOString().slice(0, 7);
    const payoutsSaved = [];

    for (const userShare of userShares) {
      if (userShare.shares <= 0) continue;

      // Skip users who already received a payout this month to prevent duplicates.
      const existing = await Payout.findOne({ username: userShare.username, month: currentMonth });
      if (existing) continue;

      const breakdown: IPayoutBreakdownEntry[] = [];
      let totalUSD = 0;

      for (const pool of tokenPools) {
        if (pool.balance <= 0) continue;
        const valuePerShare = pool.balance / totalShares;
        const amount = userShare.shares * valuePerShare;
        if (amount <= 0) continue;

        try {
          console.log(`Executing live transfer of ${amount} ${pool.symbol} to ${userShare.walletAddress}...`);
          const erc20WithSigner = getErc20(pool.address).connect(adminWallet) as ethers.Contract;
          // Truncate to a sane precision before scaling to the token's real decimals -
          // JS floating point division doesn't carry more real precision than this anyway.
          const precision = Math.min(pool.decimals, 8);
          const amountToTransfer = ethers.parseUnits(amount.toFixed(precision), pool.decimals);

          const tx = await erc20WithSigner.transfer(userShare.walletAddress, amountToTransfer);
          console.log(`Transaction sent! Hash: ${tx.hash}`);
          await tx.wait(1);
          console.log(`Transaction confirmed for ${userShare.username} (${pool.symbol}).`);

          breakdown.push({ symbol: pool.symbol, tokenAddress: pool.address, amount, txHash: tx.hash, status: 'PAID' });
          totalUSD += amount;
        } catch (e: any) {
          console.error(`Failed to transfer ${pool.symbol} to ${userShare.walletAddress}:`, e.message);
          breakdown.push({ symbol: pool.symbol, tokenAddress: pool.address, amount, status: 'FAILED' });
        }
      }

      if (breakdown.length === 0) continue; // nothing payable this month for this user in any token

      const paidEntry = breakdown.find((b) => b.status === 'PAID');
      const newPayout = await Payout.create({
        walletAddress: userShare.walletAddress,
        username: userShare.username,
        rank: userShare.rank,
        amountUSDC: totalUSD,
        shares: userShare.shares,
        txHash: paidEntry?.txHash,
        breakdown,
        month: currentMonth,
        status: paidEntry ? 'PAID' : 'FAILED',
      });
      payoutsSaved.push(newPayout);
    }

    console.log(`✅ Monthly Leadership Pool generated for ${currentMonth}. Created ${payoutsSaved.length} new payouts.`);
    return payoutsSaved;
  }

  /** Every leadership payout a wallet has ever received (most recent first), for the network page's Leadership Bonus card. */
  static async getPayoutHistory(walletAddress: string) {
    return Payout.find({ walletAddress: walletAddress.toLowerCase() }).sort({ createdAt: -1 });
  }
}
