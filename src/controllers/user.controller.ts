import { Request, Response, NextFunction } from 'express';
import { UserService, UserError } from '../services/user.service';
import { FeatureGatingService } from '../services/feature-gating.service';
import { sendSuccess, sendError } from '../utils/response';
function handleUserError(res: Response, error: unknown, next: NextFunction): void {
  if (error instanceof UserError) {
    sendError(res, error.message, error.statusCode, { code: error.code });
    return;
  }
  next(error);
}

export class UserController {
  static async validateSponsor(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { username } = req.params;
      const data = await UserService.validateSponsor(String(username ?? ''));
      sendSuccess(res, data, 'Sponsor is eligible');
    } catch (error) {
      handleUserError(res, error, next);
    }
  }

  static async checkUsername(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { username } = req.params;
      const data = await UserService.checkUsernameAvailability(String(username ?? ''));
      sendSuccess(res, data, data.available ? 'Username is available' : 'Username is already taken');
    } catch (error) {
      handleUserError(res, error, next);
    }
  }

  static async register(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await UserService.registerUser(req.body);
      sendSuccess(res, user, 'User registered successfully', 201);
    } catch (error) {
      handleUserError(res, error, next);
    }
  }

  static async searchUsernames(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : 8;
      const items = await UserService.searchUsernames(q, {
        limit: Number.isFinite(limitRaw) ? limitRaw : 8,
        excludeWallet: req.walletAddress,
      });
      sendSuccess(res, { items }, 'Usernames retrieved');
    } catch (error) {
      handleUserError(res, error, next);
    }
  }

  static async getProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { username } = req.params;
      let user = await UserService.getUserByUsername(username as string);

      if (!user) {
        res.status(404);
        throw new Error('User not found');
      }

      user = await UserService.syncUserTierWithBlockchain(user);

      const unlockedFeatures = {
        educationHub: await FeatureGatingService.canAccessEducation(user.walletAddress),
        tailorOTC: await FeatureGatingService.canAccessOTC(user.walletAddress),
        nftLending: await FeatureGatingService.canAccessLending(user.walletAddress),
      };

      sendSuccess(res, { profile: user, unlockedFeatures }, 'Profile retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  static async getProfileByWallet(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { walletAddress } = req.params;
      let user = await UserService.getUserByWallet(walletAddress as string);

      if (!user) {
        res.status(404);
        throw new Error('User not found');
      }

      user = await UserService.syncUserTierWithBlockchain(user);

      const unlockedFeatures = {
        educationHub: await FeatureGatingService.canAccessEducation(user.walletAddress),
        tailorOTC: await FeatureGatingService.canAccessOTC(user.walletAddress),
        nftLending: await FeatureGatingService.canAccessLending(user.walletAddress),
      };

      sendSuccess(res, { profile: user, unlockedFeatures }, 'Profile retrieved successfully');
    } catch (error) {
      next(error);
    }
  }
}
