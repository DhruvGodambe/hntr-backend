import { Router } from 'express';
import { AdminController } from '../controllers/admin.controller';
import { requireAdminSecret } from '../middlewares/adminAuth.middleware';

const router = Router();

router.get('/dashboard', AdminController.getDashboardStats);
router.post('/run-leadership-payout', requireAdminSecret, AdminController.runLeadershipPayout);
router.post('/run-achievement-payout', requireAdminSecret, AdminController.runAchievementPayout);
router.post('/recalculate-volumes', requireAdminSecret, AdminController.recalculateVolumes);
router.get('/company-wallet', requireAdminSecret, AdminController.getCompanyWalletInfo);
router.get('/overdue-wallets/:token', requireAdminSecret, AdminController.getOverdueWallets);
router.post('/company-withdraw', requireAdminSecret, AdminController.runCompanyWithdrawal);

export default router;
