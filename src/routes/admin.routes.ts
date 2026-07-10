import { Router } from 'express';
import { AdminController } from '../controllers/admin.controller';

const router = Router();

router.get('/dashboard', AdminController.getDashboardStats);

export default router;
