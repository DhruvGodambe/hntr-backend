import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth.service';
import { sendSuccess, sendError } from '../utils/response';

export class AuthController {
  static async getNonce(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { walletAddress } = req.query;
      if (!walletAddress || typeof walletAddress !== 'string') {
        sendError(res, 'walletAddress query param is required', 400);
        return;
      }
      const { nonce, message } = AuthService.issueNonce(walletAddress);
      sendSuccess(res, { nonce, message }, 'Nonce issued');
    } catch (error) {
      next(error);
    }
  }

  static async verify(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { walletAddress, signature } = req.body;
      if (!walletAddress || !signature) {
        sendError(res, 'walletAddress and signature are required', 400);
        return;
      }
      const token = AuthService.verifySignatureAndIssueToken(walletAddress, signature);
      sendSuccess(res, { token, walletAddress: walletAddress.toLowerCase() }, 'Authenticated');
    } catch (error: any) {
      sendError(res, error.message || 'Verification failed', 401);
    }
  }
}
