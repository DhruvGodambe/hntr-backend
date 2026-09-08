import { Request, Response, NextFunction } from 'express';
import { VoucherAdminService } from '../services/voucherAdmin.service';
import { VoucherError } from '../services/voucher.service';
import { VoucherBalanceError } from '../services/voucherBalance';
import { sendSuccess, sendError } from '../utils/response';

function handle(res: Response, error: any, next: NextFunction) {
  if (error instanceof VoucherError || error instanceof VoucherBalanceError) {
    sendError(res, error.message, error.statusCode, { code: error.code });
    return;
  }
  next(error);
}

function admin(req: Request): string {
  return req.adminUsername || 'admin';
}

function param(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

export class VoucherAdminController {
  static async listAccounts(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      sendSuccess(res, await VoucherAdminService.listAccounts(req.query as Record<string, unknown>), 'OK');
    } catch (e) {
      handle(res, e, next);
    }
  }

  static async setAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { enabled, reason } = req.body || {};
      if (typeof enabled !== 'boolean') {
        sendError(res, 'enabled (boolean) is required', 400);
        return;
      }
      sendSuccess(
        res,
        await VoucherAdminService.setAccess(admin(req), param(req.params.username), enabled, reason),
        enabled ? 'Access enabled' : 'Access disabled',
      );
    } catch (e) {
      handle(res, e, next);
    }
  }

  static async adjustBalance(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { token, delta, note } = req.body || {};
      if (!token || delta === undefined) {
        sendError(res, 'token and delta are required', 400);
        return;
      }
      sendSuccess(
        res,
        await VoucherAdminService.adjustBalance(admin(req), param(req.params.username), token, Number(delta), note),
        'Balance updated',
      );
    } catch (e) {
      handle(res, e, next);
    }
  }

  static async listVouchers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      sendSuccess(res, await VoucherAdminService.listVouchers(req.query as Record<string, unknown>), 'OK');
    } catch (e) {
      handle(res, e, next);
    }
  }

  static async revokeVoucher(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { reason } = req.body || {};
      if (!reason) {
        sendError(res, 'reason is required', 400);
        return;
      }
      sendSuccess(
        res,
        await VoucherAdminService.revokeVoucher(admin(req), param(req.params.voucherId), String(reason)),
        'Voucher revoked',
      );
    } catch (e) {
      handle(res, e, next);
    }
  }

  static async listLedger(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      sendSuccess(res, await VoucherAdminService.listLedger(req.query as Record<string, unknown>), 'OK');
    } catch (e) {
      handle(res, e, next);
    }
  }

  static async getBurner(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      sendSuccess(res, await VoucherAdminService.getBurner(), 'OK');
    } catch (e) {
      handle(res, e, next);
    }
  }

  static async recordBurner(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { txHash, burnerWallet } = req.body || {};
      if (!txHash || !burnerWallet) {
        sendError(res, 'txHash and burnerWallet are required', 400);
        return;
      }
      sendSuccess(
        res,
        await VoucherAdminService.recordBurnerRotation(admin(req), String(txHash), String(burnerWallet)),
        'Recorded',
      );
    } catch (e) {
      handle(res, e, next);
    }
  }

  static async reconcile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { username, token } = req.body || {};
      sendSuccess(res, await VoucherAdminService.reconcile(admin(req), { username, token }), 'Reconciled');
    } catch (e) {
      handle(res, e, next);
    }
  }

  static async ownerWallet(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      sendSuccess(res, await VoucherAdminService.ownerWallet(), 'OK');
    } catch (e) {
      handle(res, e, next);
    }
  }

  static async listBonusReview(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      sendSuccess(res, await VoucherAdminService.listBonusReview(req.query as Record<string, unknown>), 'OK');
    } catch (e) {
      handle(res, e, next);
    }
  }

  static async reviewBonus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const decision = req.path.endsWith('/approve') ? 'approve' : 'reject';
      const { reason } = req.body || {};
      sendSuccess(
        res,
        await VoucherAdminService.reviewBonus(admin(req), param(req.params.id), decision, reason),
        decision === 'approve' ? 'Bonus approved' : 'Bonus rejected',
      );
    } catch (e) {
      handle(res, e, next);
    }
  }
}
