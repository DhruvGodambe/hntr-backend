import { Request, Response, NextFunction } from 'express';
import User from '../models/User';
import Transaction from '../models/Transaction';
import { RewardsService } from '../services/rewards.service';
import { NetworkService } from '../services/network.service';
import { SecurityWalletService } from '../services/securityWallet.service';
import { runMonthlyLeadershipPayout, runAchievementBonusDisbursement } from '../jobs/leadership-cron';
import { sendSuccess } from '../utils/response';

export class AdminController {
  static async getDashboardStats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const totalUsers = await User.countDocuments();
      const recentTransactions = await Transaction.find().sort({ timestamp: -1 }).limit(10);
      
      const tierStats = await User.aggregate([
        { $group: { _id: '$tier', count: { $sum: 1 } } }
      ]);
  
      sendSuccess(res, {
        totalUsers,
        tierStats,
        recentTransactions
      }, 'Admin stats retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * Manually runs the monthly leadership payout distribution on demand, instead of
   * waiting for the 1st-of-the-month cron tick - useful for testing/verifying the
   * flow, or for re-running it if it needs to be triggered outside its schedule.
   */
  static async runLeadershipPayout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await runMonthlyLeadershipPayout();
      sendSuccess(res, result, `Leadership cron completed (${result.paid} paid, ${result.failed} failed)`);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Manually runs the daily rank-achievement bonus disbursement on demand
   * (same logic as the 00:30 UTC cron).
   */
  static async runAchievementPayout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await runAchievementBonusDisbursement();
      sendSuccess(res, result, `Paid ${result.paid} achievement bonus(es)`);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Forces a recalculation of leg volumes, team volume, and rank for a user and
   * every upline ancestor. Useful when a purchase/upgrade was processed but a
   * wallet's volume looks stale because an earlier listener tick failed part-way.
   */
  static async recalculateVolumes(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { username } = req.body;
      if (!username || typeof username !== 'string') {
        sendSuccess(res, { error: 'username is required' }, 'Missing username', 400);
        return;
      }

      const user = await User.findOne({ username });
      if (!user) {
        sendSuccess(res, { error: 'User not found' }, 'User not found', 404);
        return;
      }

      const results = await NetworkService.recalculateUplineVolumes(username);
      sendSuccess(res, { results }, `Recalculated volumes for ${results.length} user(s)`);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Reads the on-chain security-wallet address and the current pool-wallet balance.
   * The pool wallet receives the 20% locked portion of every commission.
   */
  static async getSecurityWalletInfo(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const [address, usdtBalance, usdcBalance] = await Promise.all([
        SecurityWalletService.getSecurityWalletAddress(),
        SecurityWalletService.getPoolWalletBalance('USDT').catch(() => ({ balance: 0 })),
        SecurityWalletService.getPoolWalletBalance('USDC').catch(() => ({ balance: 0 })),
      ]);
      sendSuccess(
        res,
        {
          securityWalletAddress: address,
          configured: !!address,
          poolWallet: { usdt: usdtBalance.balance, usdc: usdcBalance.balance },
        },
        'Security wallet info retrieved successfully',
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * Returns all wallets whose last commission claim is overdue for a given token.
   */
  static async getUnclaimedWallets(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rawToken = req.params.token || 'USDT';
      const token = (Array.isArray(rawToken) ? rawToken[0] : rawToken).toUpperCase();
      const result = await SecurityWalletService.getUnclaimedWallets(token);
      sendSuccess(res, result, `Found ${result.count} overdue wallet(s)`);
    } catch (error) {
      next(error);
    }
  }
}
