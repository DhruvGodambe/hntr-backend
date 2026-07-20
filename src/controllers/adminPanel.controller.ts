import { Request, Response, NextFunction } from 'express';
import { ENV } from '../config/env';
import { AdminAuthService } from '../services/adminAuth.service';
import { AdminPanelService, AdminPanelError } from '../services/adminPanel.service';
import { parsePagination } from '../utils/pagination';
import { sendSuccess, sendError } from '../utils/response';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function handlePanelError(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof AdminPanelError) {
    sendError(res, err.message, err.statusCode, { code: err.code });
    return;
  }
  next(err);
}

export class AdminPanelController {
  static async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!AdminAuthService.isConfigured()) {
        sendError(res, 'Admin panel is disabled: ADMIN_PASSWORD is not configured.', 503);
        return;
      }

      const { password } = req.body;
      if (!password || typeof password !== 'string') {
        sendError(res, 'Password is required.', 400);
        return;
      }

      if (!AdminAuthService.verifyPassword(password)) {
        sendError(res, 'Invalid credentials.', 401);
        return;
      }

      const token = AdminAuthService.issueToken();
      const expiresAt = Date.now() + ENV.ADMIN_TOKEN_TTL_SECONDS * 1000;

      sendSuccess(res, { token, expiresAt, role: 'admin' }, 'Admin authenticated successfully');
    } catch (error) {
      next(error);
    }
  }

  static async getMetrics(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await AdminPanelService.getMetrics();
      sendSuccess(res, data, 'Platform metrics retrieved successfully');
    } catch (error) {
      handlePanelError(error, res, next);
    }
  }

  static async getRecentActivity(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
      const data = await AdminPanelService.getRecentActivity(page, limit, skip);
      sendSuccess(res, data, 'Recent activity retrieved successfully');
    } catch (error) {
      handlePanelError(error, res, next);
    }
  }

  static async getUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
      const search = typeof req.query.search === 'string' ? req.query.search : '';
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const data = await AdminPanelService.getUsers(search, page, limit, skip, status);
      sendSuccess(res, data, 'Users retrieved successfully');
    } catch (error) {
      handlePanelError(error, res, next);
    }
  }

  static async blockUser(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const username = paramString(req.params.username);
      const { reason } = req.body || {};
      const data = await AdminPanelService.setUserBlocked(username, true, reason);
      sendSuccess(res, data, data.message);
    } catch (error) {
      handlePanelError(error, res, next);
    }
  }

  static async unblockUser(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const username = paramString(req.params.username);
      const data = await AdminPanelService.setUserBlocked(username, false);
      sendSuccess(res, data, data.message);
    } catch (error) {
      handlePanelError(error, res, next);
    }
  }

  static async overrideUser(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const username = paramString(req.params.username);
      const { tier, rank } = req.body || {};
      const data = await AdminPanelService.overrideUserProfile(username, tier, rank);
      sendSuccess(res, data, data.message);
    } catch (error) {
      handlePanelError(error, res, next);
    }
  }

  static async getTransactions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
      const type = typeof req.query.type === 'string' ? req.query.type : 'all';
      const search = typeof req.query.search === 'string' ? req.query.search : '';
      const data = await AdminPanelService.getTransactions(type, page, limit, skip, search);
      sendSuccess(res, data, 'Transactions retrieved successfully');
    } catch (error) {
      handlePanelError(error, res, next);
    }
  }

  static async getWallets(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await AdminPanelService.getWalletBalances();
      sendSuccess(res, data, 'Wallet balances retrieved successfully');
    } catch (error) {
      handlePanelError(error, res, next);
    }
  }

  static async getWalletLedger(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
      const walletKey = paramString(req.params.walletKey);
      const data = await AdminPanelService.getWalletLedger(walletKey, page, limit, skip);
      sendSuccess(res, data, 'Wallet ledger retrieved successfully');
    } catch (error) {
      handlePanelError(error, res, next);
    }
  }

  static async getLeadershipPreview(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await AdminPanelService.getLeadershipPreview();
      sendSuccess(res, data, 'Leadership pool preview retrieved successfully');
    } catch (error) {
      handlePanelError(error, res, next);
    }
  }

  static async distributeLeadership(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await AdminPanelService.distributeLeadership();
      sendSuccess(res, data, `Leadership rewards distributed (${data.paid} paid, ${data.failed} failed).`);
    } catch (error) {
      handlePanelError(error, res, next);
    }
  }

  static async distributeAchievement(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await AdminPanelService.distributeAchievement();
      sendSuccess(res, data, `Achievement bonuses disbursed (${data.paid} paid).`);
    } catch (error) {
      handlePanelError(error, res, next);
    }
  }

  static async getRankBonusReport(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
      const data = await AdminPanelService.getRankBonusReport(page, limit, skip);
      sendSuccess(res, data, 'Rank bonus report retrieved successfully');
    } catch (error) {
      handlePanelError(error, res, next);
    }
  }

  static async getOverdueCommissions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const token = typeof req.query.token === 'string' ? req.query.token : 'USDT';
      const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>, { limit: 10 });
      const data = await AdminPanelService.getOverdueCommissionsWithAmounts(token, page, limit, skip);
      sendSuccess(res, data, `Found ${data.pagination?.total ?? 0} overdue wallet(s)`);
    } catch (error) {
      handlePanelError(error, res, next);
    }
  }

  static async claimCommissions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { walletAddresses, token } = req.body || {};
      if (!Array.isArray(walletAddresses) || walletAddresses.length === 0) {
        sendError(res, 'walletAddresses array is required.', 400);
        return;
      }
      if (walletAddresses.length > 50) {
        sendError(res, 'Cannot process more than 50 wallets at once.', 400);
        return;
      }
      const data = await AdminPanelService.claimCommissionsForWallets(walletAddresses, token || 'USDT');
      const succeeded = data.filter((r) => r.success).length;
      sendSuccess(res, { results: data, succeeded, failed: data.length - succeeded }, 'Commission claims processed');
    } catch (error) {
      handlePanelError(error, res, next);
    }
  }

  static async recalculateVolumes(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { username } = req.body || {};
      if (!username || typeof username !== 'string') {
        sendError(res, 'username is required.', 400);
        return;
      }
      const data = await AdminPanelService.recalculateVolumes(username);
      sendSuccess(res, data, `Recalculated volumes for ${data.count} user(s)`);
    } catch (error) {
      handlePanelError(error, res, next);
    }
  }

  static async getPools(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>, { limit: 50 });
      const data = await AdminPanelService.getStrategyPools(page, limit, skip);
      sendSuccess(res, data, 'Strategy pools retrieved successfully');
    } catch (error) {
      handlePanelError(error, res, next);
    }
  }

  static async createPool(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { name, slug, targetEth, imageUrl, collectionName } = req.body || {};
      if (!name || typeof name !== 'string') {
        sendError(res, 'name is required.', 400);
        return;
      }
      if (targetEth === undefined || Number(targetEth) <= 0) {
        sendError(res, 'targetEth must be a positive number.', 400);
        return;
      }
      const data = await AdminPanelService.createStrategyPool({
        name,
        slug,
        targetEth: Number(targetEth),
        imageUrl,
        collectionName,
      });
      sendSuccess(res, data, 'Strategy pool created successfully', 201);
    } catch (error) {
      handlePanelError(error, res, next);
    }
  }

  static async updatePool(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const poolId = paramString(req.params.poolId);
      const data = await AdminPanelService.updateStrategyPool(poolId, req.body || {});
      sendSuccess(res, data, 'Strategy pool updated successfully');
    } catch (error) {
      handlePanelError(error, res, next);
    }
  }

  static async deletePool(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const poolId = paramString(req.params.poolId);
      const data = await AdminPanelService.deleteStrategyPool(poolId);
      sendSuccess(res, data, 'Strategy pool deleted successfully');
    } catch (error) {
      handlePanelError(error, res, next);
    }
  }

  static async getMaintenance(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await AdminPanelService.getMaintenanceSettings();
      sendSuccess(res, data, 'Maintenance settings retrieved successfully');
    } catch (error) {
      handlePanelError(error, res, next);
    }
  }

  static async setMaintenance(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { maintenanceMode, maintenanceMessage } = req.body || {};
      if (typeof maintenanceMode !== 'boolean') {
        sendError(res, 'maintenanceMode boolean is required.', 400);
        return;
      }
      const data = await AdminPanelService.setMaintenanceSettings(maintenanceMode, maintenanceMessage);
      sendSuccess(res, data, maintenanceMode ? 'Maintenance mode enabled.' : 'Maintenance mode disabled.');
    } catch (error) {
      handlePanelError(error, res, next);
    }
  }
}
