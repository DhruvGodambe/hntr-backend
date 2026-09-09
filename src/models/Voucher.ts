import mongoose, { Schema, Document } from 'mongoose';

export type VoucherStatus =
  | 'ACTIVE'
  | 'REDEEMING'
  | 'REDEEMED'
  | 'EXPIRED'
  | 'REVOKED'
  | 'FAILED';

export type VoucherToken = 'USDT' | 'USDC';

export interface IVoucher extends Document {
  /** 0x-prefixed bytes32, random, unrelated to the code — the on-chain identifier. */
  voucherId: string;
  /** HMAC-SHA256(VOUCHER_CODE_PEPPER, normalizedCode) hex — the redemption lookup key. */
  codeHash: string;
  /** AES-256-GCM "iv:tag:ciphertext" base64 — issuer-only re-reveal. */
  codeCipher: string;
  /** Last 4 plaintext chars, for tables without decryption. */
  codeLast4: string;

  issuerWallet: string;
  issuerUsername: string;

  tier: 'Bronze' | 'Silver' | 'Gold' | 'Platinum' | 'Diamond';
  /** 1..5, matches the on-chain Tier enum (NONE=0). */
  tierIndex: number;
  /** TIER_VOLUMES[tier], denormalized at issue so a later price change cannot alter the refund. */
  amountUsd: number;
  /** Which balance bucket was debited. */
  token: VoucherToken;

  status: VoucherStatus;
  note?: string;

  /**
   * Bearer code: whoever redeems it first gets it, no matter how many people it
   * was sent to. Tracked so re-sharing the same recipient set is idempotent (no
   * duplicate notifications) and so the other recipients can be told the code is
   * gone once someone redeems it.
   */
  sharedWith: { username: string; walletAddress: string; notifiedAt: Date }[];

  expiresAt: Date;

  /** Set when status flips to REDEEMING; cleared/stale-swept by the cron. */
  redeemLockedAt?: Date;
  redeemAttempts: number;

  redeemerWallet?: string;
  redeemerUsername?: string;
  redeemedAt?: Date;
  txHash?: string;
  /** Redeemer's tier immediately before redemption. */
  tierBefore?: string;

  expiredAt?: Date;
  revokedAt?: Date;
  /** Admin username, or 'issuer'. */
  revokedBy?: string;
  revokeReason?: string;
  errorMessage?: string;

  createdAt: Date;
  updatedAt: Date;
}

const VoucherSchema: Schema = new Schema(
  {
    voucherId: { type: String, required: true, unique: true },
    codeHash: { type: String, required: true, unique: true },
    codeCipher: { type: String, required: true },
    codeLast4: { type: String, required: true },

    issuerWallet: { type: String, required: true, lowercase: true, index: true },
    issuerUsername: { type: String, required: true },

    tier: {
      type: String,
      enum: ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'],
      required: true,
    },
    tierIndex: { type: Number, required: true, min: 1, max: 5 },
    amountUsd: { type: Number, required: true, min: 0 },
    token: { type: String, enum: ['USDT', 'USDC'], required: true },

    status: {
      type: String,
      enum: ['ACTIVE', 'REDEEMING', 'REDEEMED', 'EXPIRED', 'REVOKED', 'FAILED'],
      default: 'ACTIVE',
    },
    note: { type: String, maxlength: 64 },

    sharedWith: {
      type: [
        {
          username: { type: String, required: true },
          walletAddress: { type: String, required: true, lowercase: true },
          notifiedAt: { type: Date, required: true },
        },
      ],
      default: [],
      _id: false,
    },

    expiresAt: { type: Date, required: true },

    redeemLockedAt: { type: Date },
    redeemAttempts: { type: Number, default: 0 },

    redeemerWallet: { type: String, lowercase: true },
    redeemerUsername: { type: String },
    redeemedAt: { type: Date },
    txHash: { type: String },
    tierBefore: { type: String },

    expiredAt: { type: Date },
    revokedAt: { type: Date },
    revokedBy: { type: String },
    revokeReason: { type: String, maxlength: 256 },
    errorMessage: { type: String },
  },
  { timestamps: true },
);

VoucherSchema.index({ issuerWallet: 1, createdAt: -1 });
VoucherSchema.index({ status: 1, expiresAt: 1 }); // expiry cron scan
VoucherSchema.index({ status: 1, redeemLockedAt: 1 }); // stale-REDEEMING sweep
VoucherSchema.index({ redeemerWallet: 1 }, { sparse: true });
VoucherSchema.index({ txHash: 1 }, { sparse: true }); // event-handler reconcile

export default mongoose.model<IVoucher>('Voucher', VoucherSchema);
