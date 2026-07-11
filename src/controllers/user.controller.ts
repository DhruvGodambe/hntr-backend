import { Request, Response, NextFunction } from 'express';
import { UserService } from '../services/user.service';
import { FeatureGatingService } from '../services/feature-gating.service';
import { sendSuccess } from '../utils/response';

export class UserController {
  static async register(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await UserService.registerUser(req.body);
      sendSuccess(res, user, 'User registered successfully', 201);
    } catch (error) {
      next(error);
    }
  }

  static async getProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { username } = req.params;
      const user = await UserService.getUserByUsername(username as string);
      
      if (!user) {
        res.status(404);
        throw new Error('User not found');
      }

      const unlockedFeatures = {
        educationHub: await FeatureGatingService.canAccessEducation(user.walletAddress),
        tailorOTC: await FeatureGatingService.canAccessOTC(user.walletAddress),
        nftLending: await FeatureGatingService.canAccessLending(user.walletAddress)
      };

      sendSuccess(res, { profile: user, unlockedFeatures }, 'Profile retrieved successfully');
    } catch (error) {
      next(error);
    }
  }
}
