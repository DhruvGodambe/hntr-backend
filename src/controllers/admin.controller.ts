import { Request, Response, NextFunction } from 'express';
import User from '../models/User';
import Transaction from '../models/Transaction';
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
}
