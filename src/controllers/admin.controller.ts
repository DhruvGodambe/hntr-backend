import { Request, Response, NextFunction } from 'express';
import User from '../models/User';
import Transaction from '../models/Transaction';
import { RewardsService } from '../services/rewards.service';
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
      const payouts = await RewardsService.calculateMonthlyLeadershipPool();
      sendSuccess(res, { payouts }, `Generated ${payouts.length} leadership payout(s)`);
    } catch (error) {
      next(error);
    }
  }
}
