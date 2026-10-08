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

export class PriorityLineController {
  static async getOverview(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      sendSuccess(res, await PriorityLineService.getOverview(req.walletAddress!), 'OK');
    } catch (error) {
      handle(res, error, next);
    }
  }

  static async prepareDeposit(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { token, amount } = req.body || {};
      if (!token || amount === undefined) {
        sendError(res, 'token and amount are required', 400);
        return;
      }
      sendSuccess(res, await PriorityLineService.prepareDeposit(req.walletAddress!, token, amount), 'OK');
    } catch (error) {
      handle(res, error, next);
    }
  }

  static async confirmDeposit(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { txHash, token } = req.body || {};
      if (!txHash || !token) {
        sendError(res, 'txHash and token are required', 400);
        return;
      }
      sendSuccess(res, await PriorityLineService.confirmDeposit(req.walletAddress!, txHash, token), 'Deposit recorded');
    } catch (error) {
      handle(res, error, next);
    }
  }

  static async requestWithdrawal(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { depositId } = req.body || {};
      if (!depositId) {
        sendError(res, 'depositId is required', 400);
        return;
      }
      sendSuccess(res, await PriorityLineService.requestWithdrawal(req.walletAddress!, depositId), 'Withdrawal requested');
    } catch (error) {
      handle(res, error, next);
    }
  }
}
