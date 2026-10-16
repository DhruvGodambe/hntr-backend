import { Request, Response, NextFunction } from 'express';
import { SupportService, SupportError } from '../services/support.service';
import { sendSuccess, sendError } from '../utils/response';

function handle(res: Response, error: any, next: NextFunction) {
  if (error instanceof SupportError) {
    sendError(res, error.message, error.statusCode, { code: error.code });
    return;
  }
  next(error);
}

function param(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

export class SupportController {
  static async listTickets(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      sendSuccess(res, await SupportService.listMine(req.walletAddress!), 'OK');
    } catch (error) {
      handle(res, error, next);
    }
  }

  static async createTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      sendSuccess(res, await SupportService.createTicket(req.walletAddress!, req.body || {}), 'Ticket created', 201);
    } catch (error) {
      handle(res, error, next);
    }
  }

  static async replyToTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { body } = req.body || {};
      sendSuccess(res, await SupportService.replyAsMember(req.walletAddress!, param(req.params.id), body), 'Reply sent');
    } catch (error) {
      handle(res, error, next);
    }
  }
}
