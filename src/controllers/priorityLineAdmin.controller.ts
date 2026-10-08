import { Request, Response, NextFunction } from 'express';
import { PriorityLineService, PriorityLineError } from '../services/priorityLine.service';
import { sendSuccess, sendError } from '../utils/response';

function handle(res: Response, error: any, next: NextFunction) {
  if (error instanceof PriorityLineError) {
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

export class PriorityLineAdminController {
  static async getSettings(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      sendSuccess(res, await PriorityLineService.getSettings(), 'OK');
    } catch (error) {
      handle(res, error, next);
    }
  }

  static async setSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { depositWallet } = req.body || {};
      if (!depositWallet) {
        sendError(res, 'depositWallet is required', 400);
        return;
      }
      sendSuccess(res, await PriorityLineService.setDepositWallet(depositWallet, admin(req)), 'Deposit wallet updated');
    } catch (error) {
      handle(res, error, next);
    }
  }

  static async getStats(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      sendSuccess(res, await PriorityLineService.getStats(), 'OK');
    } catch (error) {
      handle(res, error, next);
    }
  }

  static async listDeposits(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      sendSuccess(res, await PriorityLineService.listDeposits(req.query), 'OK');
    } catch (error) {
      handle(res, error, next);
    }
  }

  static async listWithdrawals(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      sendSuccess(res, await PriorityLineService.listWithdrawals(req.query), 'OK');
    } catch (error) {
      handle(res, error, next);
    }
  }

  static async completeWithdrawal(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { payoutTxHash, note } = req.body || {};
      sendSuccess(
        res,
        await PriorityLineService.completeWithdrawal(param(req.params.id), admin(req), { payoutTxHash, note }),
        'Withdrawal marked as paid',
      );
    } catch (error) {
      handle(res, error, next);
    }
  }

  static async rejectWithdrawal(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { note } = req.body || {};
      sendSuccess(
        res,
        await PriorityLineService.rejectWithdrawal(param(req.params.id), admin(req), note),
        'Withdrawal request declined',
      );
    } catch (error) {
      handle(res, error, next);
    }
  }
}
