import User from '../models/User';
import Payout from '../models/Payout';
import { ethers } from 'ethers';
import { hntrContract, provider } from './contract.service';

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
   * Calculates the monthly leadership pool distribution based on live on-chain balances.
   */
  static async calculateMonthlyLeadershipPool() {
    // 1. Fetch on-chain balances
    const usdcAddress = await hntrContract.usdc();
    const leadershipWallet = await hntrContract.leadershipWallet();
    
    // Quick ABI just for checking balance and transferring
    const erc20Abi = [
      "function balanceOf(address owner) view returns (uint256)",
      "function transfer(address to, uint256 amount) returns (bool)"
    ];
    const usdcContract = new ethers.Contract(usdcAddress, erc20Abi, provider);
    
    // Parse the live balance from the blockchain (assuming 6 decimals for USDC)
    const rawBalance = await usdcContract.balanceOf(leadershipWallet);
    const totalPoolUSDC = Number(ethers.formatUnits(rawBalance, 6));

    console.log(`Live Leadership Pool Balance: $${totalPoolUSDC} USDC`);

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

    const valuePerShare = totalPoolUSDC / totalShares;

    const payoutReport = userShares.map(u => ({
      ...u,
      payoutUSDC: u.shares * valuePerShare
    }));

    // Generate the current month string (YYYY-MM)
    const currentMonth = new Date().toISOString().slice(0, 7);

    // Filter out users who already received a payout this month to prevent duplicates
    const payoutsSaved = [];
    
    // Set up wallet for execution
    const privateKey = process.env.LEADERSHIP_PRIVATE_KEY;
    if (!privateKey) {
        throw new Error("LEADERSHIP_PRIVATE_KEY not found in environment for automated payouts!");
    }
    const adminWallet = new ethers.Wallet(privateKey, provider);
    const usdcWithSigner = usdcContract.connect(adminWallet) as ethers.Contract;

    for (const report of payoutReport) {
      if (report.payoutUSDC <= 0) continue;

      const existing = await Payout.findOne({ username: report.username, month: currentMonth });
      if (!existing) {
        let status: 'PENDING' | 'PAID' = 'PENDING';
        let txHash = '';

        try {
            console.log(`Executing live transfer of $${report.payoutUSDC} USDC to ${report.walletAddress}...`);
            // Parse amount to 6 decimals (USDC standard), making sure to truncate any excess floating point decimals
            const formattedAmount = report.payoutUSDC.toFixed(6);
            const amountToTransfer = ethers.parseUnits(formattedAmount, 6);
            
            // Execute Transfer
            const tx = await usdcWithSigner.transfer(report.walletAddress, amountToTransfer);
            console.log(`Transaction sent! Hash: ${tx.hash}`);
            
            // Wait for confirmation
            await tx.wait(1);
            console.log(`Transaction confirmed for ${report.username}.`);
            
            status = 'PAID';
            txHash = tx.hash;
        } catch (e: any) {
            console.error(`Failed to transfer to ${report.walletAddress}:`, e.message);
        }

        const newPayout = await Payout.create({
          walletAddress: report.walletAddress,
          username: report.username,
          rank: report.rank,
          amountUSDC: report.payoutUSDC,
          shares: report.shares,
          month: currentMonth,
          status: status,
          txHash: txHash || undefined
        });
        payoutsSaved.push(newPayout);
      }
    }

    console.log(`✅ Monthly Leadership Pool generated for ${currentMonth}. Created ${payoutsSaved.length} new payouts.`);
    return payoutsSaved;
  }
}
