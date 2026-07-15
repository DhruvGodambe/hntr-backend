import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';

const router = Router();

router.get('/nonce', AuthController.getNonce);
router.post('/verify', AuthController.verify);

export default router;
