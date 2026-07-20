import { Router } from 'express';
import { AdminPanelController } from '../controllers/adminPanel.controller';
import { requireAdminPanelAuth, requireAdminPrivileged } from '../middlewares/adminPanelAuth.middleware';
import { adminApiRateLimit, adminLoginRateLimit } from '../middlewares/rateLimiter.middleware';

const router = Router();

// --- Public (rate-limited) ---
router.post('/auth/login', adminLoginRateLimit, AdminPanelController.login);

// --- All routes below require admin JWT ---
router.use(adminApiRateLimit);
router.use(requireAdminPanelAuth);

// Metrics & activity
router.get('/metrics', AdminPanelController.getMetrics);
router.get('/activity', AdminPanelController.getRecentActivity);

// Users
router.get('/users', AdminPanelController.getUsers);
router.post('/users/:username/block', AdminPanelController.blockUser);
router.post('/users/:username/unblock', AdminPanelController.unblockUser);
router.post('/users/:username/override', AdminPanelController.overrideUser);

// Transactions & wallets
router.get('/transactions', AdminPanelController.getTransactions);
router.get('/wallets', AdminPanelController.getWallets);
router.get('/wallets/:walletKey/ledger', AdminPanelController.getWalletLedger);

// Leadership & achievement (privileged — moves funds)
router.get('/leadership/preview', AdminPanelController.getLeadershipPreview);
router.post('/leadership/distribute', requireAdminPrivileged, AdminPanelController.distributeLeadership);
router.post('/achievement/distribute', requireAdminPrivileged, AdminPanelController.distributeAchievement);
router.get('/reports/rank-bonuses', AdminPanelController.getRankBonusReport);

// Overdue commissions (privileged claim)
router.get('/commissions/overdue', AdminPanelController.getOverdueCommissions);
router.post('/commissions/claim', requireAdminPrivileged, AdminPanelController.claimCommissions);

// Volume recalc
router.post('/volumes/recalculate', requireAdminPrivileged, AdminPanelController.recalculateVolumes);

// Strategy pools
router.get('/pools', AdminPanelController.getPools);
router.post('/pools', AdminPanelController.createPool);
router.put('/pools/:poolId', AdminPanelController.updatePool);
router.delete('/pools/:poolId', AdminPanelController.deletePool);

// Maintenance mode
router.get('/maintenance', AdminPanelController.getMaintenance);
router.post('/maintenance', AdminPanelController.setMaintenance);

export default router;
