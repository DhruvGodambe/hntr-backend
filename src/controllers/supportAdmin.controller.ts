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

function admin(req: Request): string {
  return req.adminUsername || 'admin';
}

function param(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

export class SupportAdminController {
  static async listTickets(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      sendSuccess(res, await SupportService.adminList(req.query), 'OK');
    } catch (error) {
      handle(res, error, next);
    }
  }

  static async getTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      sendSuccess(res, await SupportService.adminGet(param(req.params.id)), 'OK');
    } catch (error) {
      handle(res, error, next);
    }
  }

  static async replyToTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { body } = req.body || {};
      sendSuccess(res, await SupportService.adminReply(param(req.params.id), admin(req), body), 'Reply sent');
    } catch (error) {
      handle(res, error, next);
    }
  }

  static async setStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { status } = req.body || {};
      sendSuccess(res, await SupportService.adminSetStatus(param(req.params.id), admin(req), status), 'Ticket updated');
    } catch (error) {
      handle(res, error, next);
    }
  }
}
