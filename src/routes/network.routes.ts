import { Router } from 'express';
import { NetworkController } from '../controllers/network.controller';

const router = Router();

router.get('/:username/uplines', NetworkController.getUplines);
router.get('/:username/downline', NetworkController.getDownline);

export default router;
