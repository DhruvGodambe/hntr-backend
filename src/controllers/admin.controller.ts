import { Request, Response, NextFunction } from 'express';
import User from '../models/User';
import Transaction from '../models/Transaction';
import { RewardsService } from '../services/rewards.service';
import { NetworkService } from '../services/network.service';
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
}
