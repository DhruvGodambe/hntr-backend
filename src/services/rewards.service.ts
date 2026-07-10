import User from '../models/User';
import { ethers } from 'ethers';
import { hntrContract, provider } from './contract.service';

export class RewardsService {
  /**
   * Generates a report for users who achieved a new rank recently.
   * In a real system, you might track "RankUpgraded" events or timestamps in the DB.
   */
  static async generateRankBonusReport() {
    // For demonstration, we just fetch all users with ranks >= Hunter
    const eligibleUsers = await User.find({ rank: { $in: ['Hunter', 'Apex', 'Elite', 'Master', 'Legend'] } });
    
    // Typically, you'd filter by those who upgraded in the last 24h.
    // Assuming each rank has a fixed bonus
    const rankBonuses = {
      'Hunter': 5000,
      'Apex': 25000,
      'Elite': 100000,
      'Master': 250000,
      'Legend': 500000
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
   * Calculates the monthly leadership pool distribution based on live on-chain balances.
   */
  static async calculateMonthlyLeadershipPool() {
    // 1. Fetch on-chain balances
    const usdcAddress = await hntrContract.usdc();
    const leadershipWallet = await hntrContract.leadershipWallet();
    
    // Quick ABI just for checking balance
    const erc20Abi = ["function balanceOf(address owner) view returns (uint256)"];
    const usdcContract = new ethers.Contract(usdcAddress, erc20Abi, provider);
    
    // Parse the live balance from the blockchain (assuming 6 decimals for USDC)
    const rawBalance = await usdcContract.balanceOf(leadershipWallet);
    const totalPoolUSDC = Number(ethers.formatUnits(rawBalance, 6));

    console.log(`Live Leadership Pool Balance: $${totalPoolUSDC} USDC`);

    // 2. Fetch eligible users from DB
    const eligibleUsers = await User.find({ rank: { $in: ['Hunter', 'Apex', 'Elite', 'Master', 'Legend'] } });

    const sharesMap = {
      'Hunter': 1,
      'Apex': 1, // Assuming same for now, adjust based on spec
      'Elite': 3,
      'Master': 7,
      'Legend': 15
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

    const valuePerShare = totalPoolUSDC / totalShares;

    const payoutReport = userShares.map(u => ({
      ...u,
      payoutUSDC: u.shares * valuePerShare
    }));

    return payoutReport;
  }
}
