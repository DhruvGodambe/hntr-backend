import { Router } from 'express';

import { UserController } from '../controllers/user.controller';



const router = Router();



router.get('/sponsor/:username/validate', UserController.validateSponsor);

router.post('/register', UserController.register);

router.get('/:username', UserController.getProfile);

router.get('/wallet/:walletAddress', UserController.getProfileByWallet);



export default router;

