import { Router } from 'express';
import { SupportController } from '../controllers/support.controller';
import { requireWalletAuth } from '../middlewares/auth.middleware';
import { supportReplyRateLimit, supportTicketRateLimit, userApiRateLimit } from '../middlewares/rateLimiter.middleware';

const router = Router();

// Wallet-authenticated: tickets always belong to req.walletAddress, never a body field.
router.use(requireWalletAuth);

router.get('/tickets', userApiRateLimit, SupportController.listTickets);
router.post('/tickets', supportTicketRateLimit, SupportController.createTicket);
router.post('/tickets/:id/messages', supportReplyRateLimit, SupportController.replyToTicket);

export default router;
