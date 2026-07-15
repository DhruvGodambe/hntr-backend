import { ethers } from 'ethers';
import jwt from 'jsonwebtoken';
import { ENV } from '../config/env';

interface NonceEntry {
  nonce: string;
  expiresAt: number;
}

/**
 * In-memory nonce store (single-process). If this service is ever scaled
 * horizontally, move this to Redis/Mongo so nonces are shared across instances.
 */
const nonces = new Map<string, NonceEntry>();

function cleanupExpired() {
  const now = Date.now();
  for (const [addr, entry] of nonces.entries()) {
    if (entry.expiresAt <= now) nonces.delete(addr);
  }
}

export interface AuthTokenPayload {
  walletAddress: string;
}

export class AuthService {
  static buildSignMessage(walletAddress: string, nonce: string): string {
    return (
      `Sign this message to authenticate with HNTR.\n\n` +
      `Wallet: ${walletAddress.toLowerCase()}\n` +
      `Nonce: ${nonce}\n` +
      `This request will not trigger a blockchain transaction or cost any gas fees.`
    );
  }

  static issueNonce(walletAddress: string): { nonce: string; message: string } {
    cleanupExpired();
    const address = walletAddress.toLowerCase();
    const nonce = ethers.hexlify(ethers.randomBytes(16));
    nonces.set(address, { nonce, expiresAt: Date.now() + ENV.AUTH_NONCE_TTL_SECONDS * 1000 });
    return { nonce, message: this.buildSignMessage(address, nonce) };
  }

  /** Verifies the signature against the previously issued nonce and returns a session JWT. */
  static verifySignatureAndIssueToken(walletAddress: string, signature: string): string {
    cleanupExpired();
    const address = walletAddress.toLowerCase();
    const entry = nonces.get(address);
    if (!entry) {
      throw new Error('No pending sign-in request for this wallet. Request a new nonce and try again.');
    }

    const message = this.buildSignMessage(address, entry.nonce);
    let recovered: string;
    try {
      recovered = ethers.verifyMessage(message, signature).toLowerCase();
    } catch {
      throw new Error('Invalid signature');
    }

    if (recovered !== address) {
      throw new Error('Signature does not match the wallet address');
    }

    // One-time use.
    nonces.delete(address);

    const payload: AuthTokenPayload = { walletAddress: address };
    return jwt.sign(payload, ENV.JWT_SECRET, { expiresIn: ENV.AUTH_TOKEN_TTL_SECONDS });
  }

  static verifyToken(token: string): AuthTokenPayload {
    return jwt.verify(token, ENV.JWT_SECRET) as AuthTokenPayload;
  }
}
