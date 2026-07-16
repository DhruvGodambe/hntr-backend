import { Router } from 'express';
import { AdminController } from '../controllers/admin.controller';
import { requireAdminSecret } from '../middlewares/adminAuth.middleware';

const router = Router();

router.get('/dashboard', AdminController.getDashboardStats);
router.post('/run-leadership-payout', requireAdminSecret, AdminController.runLeadershipPayout);
router.post('/recalculate-volumes', requireAdminSecret, AdminController.recalculateVolumes);

export default router;
