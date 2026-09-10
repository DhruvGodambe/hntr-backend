import { Router } from 'express';
import { AdminPanelController } from '../controllers/adminPanel.controller';
import { VoucherAdminController } from '../controllers/voucherAdmin.controller';
import { requireAdminPanelAuth, requireAdminPrivileged } from '../middlewares/adminPanelAuth.middleware';
import { adminApiRateLimit, adminLoginRateLimit, adminRegisterRateLimit } from '../middlewares/rateLimiter.middleware';
import { verifyTurnstile } from '../middlewares/turnstile.middleware';

const router = Router();

// --- Public (rate-limited + Cloudflare Turnstile "verify you are human") ---
router.post('/auth/register', adminRegisterRateLimit, verifyTurnstile, AdminPanelController.register);
router.post('/auth/login', adminLoginRateLimit, verifyTurnstile, AdminPanelController.login);
router.get('/auth/me', adminApiRateLimit, AdminPanelController.me);

// --- All routes below require admin JWT ---
router.use(adminApiRateLimit);
router.use(requireAdminPanelAuth);

// Two-factor authentication (TOTP) — manage the signed-in admin's own 2FA
router.get('/auth/2fa/status', AdminPanelController.get2faStatus);
router.post('/auth/2fa/setup', AdminPanelController.setup2fa);
router.post('/auth/2fa/confirm', AdminPanelController.confirm2fa);
router.post('/auth/2fa/disable', AdminPanelController.disable2fa);

// Metrics & activity
router.get('/metrics', AdminPanelController.getMetrics);
router.get('/activity', AdminPanelController.getRecentActivity);

// Users
router.get('/users', AdminPanelController.getUsers);
router.post('/users/:username/block', AdminPanelController.blockUser);
router.post('/users/:username/unblock', AdminPanelController.unblockUser);
router.post('/users/:username/override', AdminPanelController.overrideUser);
router.post(
  '/users/:username/record-membership-override',
  requireAdminPrivileged,
  AdminPanelController.recordMembershipOverride,
);
router.post(
  '/users/:username/execute-membership-override',
  requireAdminPrivileged,
  AdminPanelController.executeMembershipOverride,
);

// Transactions & wallets
router.get('/transactions', AdminPanelController.getTransactions);
router.get('/wallets', AdminPanelController.getWallets);
router.get('/wallets/:walletKey/ledger', AdminPanelController.getWalletLedger);

// Leadership & achievement (privileged — moves funds)
router.get('/leadership/preview', AdminPanelController.getLeadershipPreview);
router.post('/leadership/distribute', requireAdminPrivileged, AdminPanelController.distributeLeadership);
router.get('/achievement/preview', AdminPanelController.getAchievementPreview);
router.post('/achievement/distribute', requireAdminPrivileged, AdminPanelController.distributeAchievement);
router.get('/disbursements', AdminPanelController.listDisbursements);
router.get('/reports/rank-bonuses', AdminPanelController.getRankBonusReport);

// Overdue commissions — list is read-only; withdraws are signed in admin UI via ConnectKit
router.get('/commissions/overdue', AdminPanelController.getOverdueCommissions);
router.get('/security-wallet', AdminPanelController.getSecurityWallet);
router.post('/commissions/record-withdraw', requireAdminPrivileged, AdminPanelController.recordSecurityWithdraw);

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

// --- Vouchers / gift codes ---
router.get('/owner-wallet', VoucherAdminController.ownerWallet);
router.get('/vouchers/accounts', VoucherAdminController.listAccounts);
router.post('/vouchers/accounts/:username/access', VoucherAdminController.setAccess);
router.post(
  '/vouchers/accounts/:username/balance',
  requireAdminPrivileged,
  VoucherAdminController.adjustBalance,
);
router.get('/vouchers', VoucherAdminController.listVouchers);
router.post('/vouchers/:voucherId/revoke', requireAdminPrivileged, VoucherAdminController.revokeVoucher);
router.get('/vouchers/ledger', VoucherAdminController.listLedger);
router.get('/vouchers/burner', VoucherAdminController.getBurner);
router.post('/vouchers/burner/record', requireAdminPrivileged, VoucherAdminController.recordBurner);
router.post('/vouchers/reconcile', requireAdminPrivileged, VoucherAdminController.reconcile);

// Achievement-bonus review queue (voucher volume held for manual approval)
router.get('/achievement-bonuses', VoucherAdminController.listBonusReview);
router.post('/achievement-bonuses/:id/approve', requireAdminPrivileged, VoucherAdminController.reviewBonus);
router.post('/achievement-bonuses/:id/reject', requireAdminPrivileged, VoucherAdminController.reviewBonus);

export default router;
