import { Request, Response, NextFunction } from 'express';
import { VoucherService, VoucherError } from '../services/voucher.service';
import { VoucherBalanceError } from '../services/voucherBalance';
import { sendSuccess, sendError } from '../utils/response';

function handle(res: Response, error: any, next: NextFunction) {
  if (error instanceof VoucherError || error instanceof VoucherBalanceError) {
    sendError(res, error.message, error.statusCode, { code: error.code });
    return;
  }
  next(error);
}

function param(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

function clientIp(req: Request): string | undefined {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.ip || req.socket.remoteAddress || undefined;
}

export class VoucherController {
  static async getAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      sendSuccess(res, await VoucherService.getAccess(req.walletAddress!), 'OK');
    } catch (error) {
      handle(res, error, next);
    }
  }

  static async listMine(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      sendSuccess(res, await VoucherService.listMine(req.walletAddress!, req.query), 'OK');
    } catch (error) {
      handle(res, error, next);
    }
  }

  static async issue(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { tier, token, note } = req.body;
      if (!tier || !token) {
        sendError(res, 'tier and token are required', 400);
        return;
      }
      const result = await VoucherService.issue(req.walletAddress!, { tier, token, note });
      sendSuccess(res, result, 'Gift code created');
    } catch (error) {
      handle(res, error, next);
    }
  }

  static async revealCode(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      sendSuccess(res, await VoucherService.revealCode(req.walletAddress!, param(req.params.voucherId)), 'OK');
    } catch (error) {
      handle(res, error, next);
    }
  }

  static async share(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { usernames } = req.body;
      if (!Array.isArray(usernames) || usernames.length === 0) {
        sendError(res, 'usernames must be a non-empty array', 400);
        return;
      }
      sendSuccess(
        res,
        await VoucherService.share(req.walletAddress!, param(req.params.voucherId), usernames),
        'Shared',
      );
    } catch (error) {
      handle(res, error, next);
    }
  }

  static async revoke(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      sendSuccess(res, await VoucherService.revoke(req.walletAddress!, param(req.params.voucherId)), 'Voucher cancelled');
    } catch (error) {
      handle(res, error, next);
    }
  }

  static async redeem(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = req.body;
      if (!code || typeof code !== 'string') {
        sendError(res, 'code is required', 400);
        return;
      }
      const result = await VoucherService.redeem(req.walletAddress!, code, clientIp(req));
      sendSuccess(res, result, 'Membership granted');
    } catch (error) {
      handle(res, error, next);
    }
  }
}
