import { Request, Response, NextFunction } from 'express';
import { MembershipService, MembershipError } from '../services/membership.service';
import { sendSuccess, sendError } from '../utils/response';

function handleMembershipError(res: Response, error: any, next: NextFunction) {
  if (error instanceof MembershipError) {
    sendError(res, error.message, error.statusCode, { code: error.code });
    return;
  }
  next(error);
}

export class MembershipController {
  static async quote(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const walletAddress = req.walletAddress!;
      const { tier, token } = req.query;
      if (!tier || !token) {
        sendError(res, 'tier and token query params are required', 400);
        return;
      }
      const quote = await MembershipService.getQuote(walletAddress, String(tier), String(token));
      sendSuccess(res, quote, 'Quote retrieved');
    } catch (error) {
      handleMembershipError(res, error, next);
    }
  }

  static async purchase(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const walletAddress = req.walletAddress!;
      const { tier, token } = req.body;
      if (!tier || !token) {
        sendError(res, 'tier and token are required', 400);
        return;
      }
      const result = await MembershipService.purchase(walletAddress, tier, token);
      sendSuccess(res, result, 'Membership purchased successfully');
    } catch (error) {
      handleMembershipError(res, error, next);
    }
  }

  static async upgrade(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const walletAddress = req.walletAddress!;
      const { tier, token } = req.body;
      if (!tier || !token) {
        sendError(res, 'tier and token are required', 400);
        return;
      }
      const result = await MembershipService.upgrade(walletAddress, tier, token);
      sendSuccess(res, result, 'Membership upgraded successfully');
    } catch (error) {
      handleMembershipError(res, error, next);
    }
  }
}
