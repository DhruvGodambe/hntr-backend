import User, { IUser } from '../models/User';
import Payout, { IPayoutBreakdownEntry } from '../models/Payout';
import AchievementBonus from '../models/AchievementBonus';
import DisbursementBatch, {
  IDispersalEntry,
  IFundTransfer,
} from '../models/DisbursementBatch';
import { ethers } from 'ethers';
import {
  hntrContract,
  contractABI,
  provider,
  getErc20,
  getContractAmountDecimals,
  CONTRACT_ADDRESS,
  burnerWallet,
} from './contract.service';
import { ENV } from '../config/env';
import {
  getAchievementBonusAmount,
  getLeadershipShares,
  LEADERSHIP_ELIGIBLE_RANKS,
  LEADERSHIP_SHARES,
  RANK_ACHIEVEMENT_BONUSES,
  ranksNewlyAchieved,
} from '../constants';
import { NotificationService } from './notification.service';

type StablecoinPool = {
  symbol: 'USDT' | 'USDC';
  address: string;
  decimals: number;
  /** Mutable remaining balance — decremented as payouts allocate funds. */
  rawBalance: bigint;
};

type TokenSlice = { pool: StablecoinPool; amountRaw: bigint };

type PlannedRecipient = {
  username: string;
  walletAddress: string;
  rank: string;
  shares?: number;
  bonusId?: string;
  amountUSD?: number;
  slices: { symbol: 'USDT' | 'USDC'; tokenAddress: string; amountRaw: bigint; decimals: number }[];
};

export class RewardsService {
  /**
   * Pick ONE token to pay a recipient's full `owedRaw` from — USDT if its pool can
   * cover the whole amount, else USDC if it can. Never splits a single recipient
   * across both tokens ("no halfies"). Returns null if neither token alone suffices.
   * Does not mutate balances — caller applies after a successful transfer.
   */
  private static planSingleToken(pools: StablecoinPool[], owedRaw: bigint): TokenSlice | null {
    const zero = BigInt(0);
    if (owedRaw <= zero) return null;
    for (const symbol of ['USDT', 'USDC'] as const) {
      const pool = pools.find((p) => p.symbol === symbol);
      if (pool && pool.rawBalance >= owedRaw) return { pool, amountRaw: owedRaw };
    }
    return null;
  }

  private static applySlices(slices: TokenSlice[]) {
    for (const { pool, amountRaw } of slices) {
      pool.rawBalance -= amountRaw;
    }
  }

  /**
   * Given the total owed for a run, split it into how much USDT vs USDC the admin
   * should send the burner: fill from the funding wallet's USDT first, then USDC for
   * the shortfall. (Recipient-level payout still pays each user in a single token.)
   */
  private static fundingSplit(
    totalOwedRaw: bigint,
    fundingWalletPools: StablecoinPool[],
  ): { requiredUsdtRaw: bigint; requiredUsdcRaw: bigint } {
    const zero = BigInt(0);
    if (totalOwedRaw <= zero) return { requiredUsdtRaw: zero, requiredUsdcRaw: zero };
    const usdtHave = fundingWalletPools.find((p) => p.symbol === 'USDT')?.rawBalance ?? zero;
    const requiredUsdtRaw = usdtHave >= totalOwedRaw ? totalOwedRaw : usdtHave;
    const requiredUsdcRaw = totalOwedRaw - requiredUsdtRaw;
    return { requiredUsdtRaw, requiredUsdcRaw };
  }

  private static async loadStablecoinPools(walletAddress: string): Promise<StablecoinPool[]> {
    const [usdtAddress, usdcAddress, amountDecimals] = await Promise.all([
      hntrContract.usdt(),
      hntrContract.usdc(),
      getContractAmountDecimals(),
    ]);

    return Promise.all(
      (
        [
          { symbol: 'USDT' as const, address: usdtAddress },
          { symbol: 'USDC' as const, address: usdcAddress },
        ] as const
      ).map(async ({ symbol, address }) => {
        const erc20 = getErc20(address);
        const rawBalance = (await erc20.balanceOf(walletAddress)) as bigint;
        return { symbol, address, decimals: amountDecimals, rawBalance };
      }),
    );
  }

  /**
   * Withdraws accrued protocol balance for both USDT and USDC from the contract.
   * Under pull-payment, protocol wallets (leadership, achievement, etc.) must call
   * this before they can transfer funds to users.
   */
  private static async withdrawProtocolBalances(walletSigner: ethers.Wallet) {
    const membershipWithSigner = new ethers.Contract(CONTRACT_ADDRESS, contractABI, walletSigner);
    const [usdtAddress, usdcAddress] = await Promise.all([
      hntrContract.usdt(),
      hntrContract.usdc(),
    ]);

    for (const [symbol, tokenAddress] of [['USDT', usdtAddress], ['USDC', usdcAddress]] as const) {
      const balance: bigint = await hntrContract.protocolBalances(walletSigner.address, tokenAddress);
      if (balance > BigInt(0)) {
        try {
          const tx = await membershipWithSigner.withdrawProtocolBalance(tokenAddress);
          await tx.wait(1);
          console.log(`Withdrew ${symbol} protocol balance (${balance}) for ${walletSigner.address}`);
        } catch (err: any) {
          console.error(`Failed to withdraw ${symbol} protocol balance: ${err.message}`);
        }
      }
    }
  }

  /**
   * Admin/report view of pending + paid one-time rank achievement bonuses.
   */
  static async generateRankBonusReport() {
    const bonuses = await AchievementBonus.find().sort({ createdAt: -1 }).lean();
    return bonuses.map((b) => ({
      username: b.username,
      walletAddress: b.walletAddress,
      rank: b.rank,
      bonusAmount: b.amountUSD,
      status: b.status,
      txHash: b.txHash,
      createdAt: b.createdAt,
      paidAt: b.paidAt,
    }));
  }

  /**
   * Create PENDING AchievementBonus rows for every rank newly crossed between
   * previousRank → newRank (unique per wallet+rank). Prefer calling with
   * previousRank=None and newRank=volume-qualified rank so forced display ranks
   * never unlock bonuses early. Does not pay — admin Distribute Rank Bonuses does
   * that via two-hop (achievement wallet → burner → user) when funded.
   */
  static async enqueueAchievementBonuses(
    user: Pick<IUser, 'username' | 'walletAddress'>,
    previousRank: string,
    newRank: string,
    opts?: { heldForReview?: boolean; reviewReason?: string },
  ) {
    const newlyAchieved = ranksNewlyAchieved(previousRank, newRank);
    const created = [];
    const status = opts?.heldForReview ? 'PENDING_REVIEW' : 'PENDING';

    for (const rank of newlyAchieved) {
      const amountUSD = getAchievementBonusAmount(rank);
      if (amountUSD <= 0) continue;

      try {
        const bonus = await AchievementBonus.create({
          walletAddress: user.walletAddress.toLowerCase(),
          username: user.username,
          rank,
          amountUSD,
          status,
          reviewReason: opts?.heldForReview ? opts?.reviewReason : undefined,
          createdAt: new Date(),
        });
        created.push(bonus);
        console.log(
          `Queued achievement bonus for ${user.username}: ${rank} $${amountUSD}`,
        );
      } catch (err: any) {
        // Duplicate key = already enqueued/paid for this rank — skip quietly.
        if (err?.code === 11000) {
          console.log(
            `Achievement bonus already exists for ${user.username} / ${rank} — skipping`,
          );
          continue;
        }
        throw err;
      }
    }

    return created;
  }

  private static requireBurnerWallet(): ethers.Wallet {
    if (!burnerWallet || !ENV.BURNER_WALLET_PRIVATE_KEY) {
      throw new Error('BURNER_WALLET_PRIVATE_KEY not configured — required for two-hop dispersal.');
    }
    return burnerWallet;
  }

  private static clonePools(pools: StablecoinPool[]): StablecoinPool[] {
    return pools.map((p) => ({ ...p, rawBalance: p.rawBalance }));
  }

  private static mergePools(a: StablecoinPool[], b: StablecoinPool[]): StablecoinPool[] {
    return a.map((pool) => {
      const other = b.find((x) => x.symbol === pool.symbol);
      return {
        ...pool,
        rawBalance: pool.rawBalance + (other?.rawBalance ?? BigInt(0)),
      };
    });
  }

  private static sumSliceTotals(
    recipients: PlannedRecipient[],
  ): Record<'USDT' | 'USDC', bigint> {
    const totals: Record<'USDT' | 'USDC', bigint> = { USDT: BigInt(0), USDC: BigInt(0) };
    for (const r of recipients) {
      for (const s of r.slices) {
        totals[s.symbol] += s.amountRaw;
      }
    }
    return totals;
  }

  /**
   * Hop 1: move shortfall from protocol wallet → burner (protocol wallet pays gas).
   * Prefer existing burner balances; only top up what is missing.
   */
  private static async fundBurnerFromProtocol(
    protocolSigner: ethers.Wallet,
    burnerAddress: string,
    needed: Record<'USDT' | 'USDC', bigint>,
    burnerPools: StablecoinPool[],
  ): Promise<IFundTransfer[]> {
    const fundTransfers: IFundTransfer[] = [];
    const zero = BigInt(0);

    for (const symbol of ['USDT', 'USDC'] as const) {
      const need = needed[symbol];
      if (need <= zero) continue;
      const burnerHave = burnerPools.find((p) => p.symbol === symbol)?.rawBalance ?? zero;
      const shortfall = need > burnerHave ? need - burnerHave : zero;
      if (shortfall <= zero) {
        console.log(`Hop1 ${symbol}: burner already has enough (need ${need}, have ${burnerHave})`);
        continue;
      }

      const pool = burnerPools.find((p) => p.symbol === symbol);
      if (!pool) throw new Error(`Missing ${symbol} pool metadata`);

      console.log(
        `Hop1 ${symbol}: transferring ${ethers.formatUnits(shortfall, pool.decimals)} from ${protocolSigner.address} → burner ${burnerAddress}`,
      );
      const erc20 = getErc20(pool.address).connect(protocolSigner) as ethers.Contract;
      const tx = await erc20.transfer(burnerAddress, shortfall);
      await tx.wait(1);
      fundTransfers.push({
        token: symbol,
        tokenAddress: pool.address,
        amountRaw: shortfall.toString(),
        amount: Number(ethers.formatUnits(shortfall, pool.decimals)),
        txHash: tx.hash,
      });
    }

    return fundTransfers;
  }

  /**
   * Pays PENDING rank bonuses from the burner wallet. The admin funds the burner
   * beforehand by connecting the rank wallet in the admin UI and transferring
   * USDT/USDC to the burner; this method only performs the burner → user payouts.
   */
  static async disbursePendingAchievementBonuses(triggeredBy = 'system') {
    const burner = this.requireBurnerWallet();
    const rankWalletAddr = await hntrContract.rankWallet();

    const pending = await AchievementBonus.find({ status: 'PENDING' }).sort({ createdAt: 1 });
    if (pending.length === 0) {
      console.log('No pending rank bonuses to disburse.');
      return [];
    }

    const burnerPoolsInitial = await this.loadStablecoinPools(burner.address);
    const planningPools = this.clonePools(burnerPoolsInitial);

    planningPools.forEach((p) =>
      console.log(
        `Rank bonus plan pool ${p.symbol}: $${ethers.formatUnits(p.rawBalance, p.decimals)} (burner)`,
      ),
    );

    const recipients: PlannedRecipient[] = [];
    const zero = BigInt(0);

    for (const bonus of pending) {
      const precision = Math.min(planningPools[0]?.decimals ?? 6, 8);
      const amountRaw = ethers.parseUnits(bonus.amountUSD.toFixed(precision), planningPools[0].decimals);
      if (amountRaw <= zero) continue;

      const slice = this.planSingleToken(planningPools, amountRaw);
      if (!slice) {
        console.log(
          `Skipping ${bonus.username} ${bonus.rank} $${bonus.amountUSD} — burner has no single token that covers it`,
        );
        continue;
      }

      recipients.push({
        username: bonus.username,
        walletAddress: bonus.walletAddress.toLowerCase(),
        rank: bonus.rank,
        bonusId: String(bonus._id),
        amountUSD: bonus.amountUSD,
        slices: [
          {
            symbol: slice.pool.symbol,
            tokenAddress: slice.pool.address,
            amountRaw: slice.amountRaw,
            decimals: slice.pool.decimals,
          },
        ],
      });
      this.applySlices([slice]);
    }

    if (recipients.length === 0) {
      console.log('No achievement bonuses payable with current funding.');
      return [];
    }

    const batch = await DisbursementBatch.create({
      type: 'RANK',
      status: 'DISPERSING',
      triggeredBy,
      protocolWallet: String(rankWalletAddr).toLowerCase(),
      burnerWallet: burner.address.toLowerCase(),
      fundTransfers: [],
      dispersals: [],
    });

    try {
      await batch.save();

      const burnerPools = await this.loadStablecoinPools(burner.address);
      const paidOut = [];
      const dispersals: IDispersalEntry[] = [];
      const fundTxHashes: string[] = [];

      for (const recipient of recipients) {
        const transferMeta: { symbol: string; amount: number; txHash: string }[] = [];
        try {
          for (const slice of recipient.slices) {
            const pool = burnerPools.find((p) => p.symbol === slice.symbol);
            if (!pool || pool.rawBalance < slice.amountRaw) {
              throw new Error(`Burner underfunded for ${slice.symbol} mid-dispersion`);
            }
            const amount = Number(ethers.formatUnits(slice.amountRaw, slice.decimals));
            const erc20 = getErc20(slice.tokenAddress).connect(burner) as ethers.Contract;
            const tx = await erc20.transfer(recipient.walletAddress, slice.amountRaw);
            console.log(`  Hop2 ${slice.symbol} ${amount} → ${recipient.walletAddress}: ${tx.hash}`);
            await tx.wait(1);
            pool.rawBalance -= slice.amountRaw;
            transferMeta.push({ symbol: slice.symbol, amount, txHash: tx.hash });
            dispersals.push({
              username: recipient.username,
              walletAddress: recipient.walletAddress,
              rank: recipient.rank,
              token: slice.symbol,
              tokenAddress: slice.tokenAddress,
              amountRaw: slice.amountRaw.toString(),
              amount,
              txHash: tx.hash,
              status: 'PAID',
              bonusId: recipient.bonusId,
            });
          }

          const bonus = pending.find((b) => String(b._id) === recipient.bonusId);
          if (!bonus) continue;

          const primary = transferMeta[0];
          bonus.status = 'PAID';
          bonus.token = transferMeta.map((t) => t.symbol).join('+');
          bonus.tokenAddress = recipient.slices[0].tokenAddress;
          bonus.txHash = primary.txHash;
          bonus.paidAt = new Date();
          bonus.batchId = String(batch._id);
          await bonus.save();
          paidOut.push(bonus);

          await NotificationService.createQuiet({
            walletAddress: bonus.walletAddress,
            type: 'ACHIEVEMENT_PAYOUT',
            title: 'Rank Bonus deposited',
            sub: `$${bonus.amountUSD.toFixed(2)} deposited for reaching ${bonus.rank}.`,
            link: 'VIEW NETWORK',
            meta: {
              rank: bonus.rank,
              amountUSD: bonus.amountUSD,
              txHash: primary.txHash,
              token: bonus.token,
              transfers: transferMeta,
              fundTxHashes,
              batchId: String(batch._id),
            },
          });

          console.log(`Paid ${bonus.username}: $${bonus.amountUSD} for ${bonus.rank}`);
        } catch (e: any) {
          console.error(`Failed hop2 achievement to ${recipient.walletAddress}:`, e.message);
          for (const slice of recipient.slices) {
            if (transferMeta.some((t) => t.symbol === slice.symbol)) continue;
            dispersals.push({
              username: recipient.username,
              walletAddress: recipient.walletAddress,
              rank: recipient.rank,
              token: slice.symbol,
              tokenAddress: slice.tokenAddress,
              amountRaw: slice.amountRaw.toString(),
              amount: Number(ethers.formatUnits(slice.amountRaw, slice.decimals)),
              status: 'FAILED',
              bonusId: recipient.bonusId,
            });
          }
          const refreshed = await this.loadStablecoinPools(burner.address);
          for (const pool of burnerPools) {
            const live = refreshed.find((r) => r.symbol === pool.symbol);
            if (live) pool.rawBalance = live.rawBalance;
          }
        }
      }

      batch.dispersals = dispersals;
      const paidCount = paidOut.length;
      batch.status =
        paidCount === recipients.length ? 'COMPLETED' : paidCount > 0 ? 'PARTIAL' : 'FAILED';
      if (batch.status === 'FAILED') batch.error = 'No achievement bonuses paid';
      await batch.save();

      console.log(
        `✅ Achievement two-hop complete. Paid ${paidOut.length} of ${recipients.length} planned.`,
      );
      return paidOut;
    } catch (err: any) {
      batch.status = 'FAILED';
      batch.error = err?.message || String(err);
      await batch.save();
      throw err;
    }
  }

  /**
   * Live USDT/USDC balances available to a protocol wallet (leadership or achievement).
   * Includes both the wallet's ERC20 balance AND unclaimed protocol balance still held
   * inside the contract (pull-payment model).
   */
  private static async getPoolWalletBalances(poolWallet: string) {
    const [usdtAddress, usdcAddress, amountDecimals] = await Promise.all([
      hntrContract.usdt(),
      hntrContract.usdc(),
      getContractAmountDecimals(),
    ]);

    const tokens = await Promise.all(
      (
        [
          { symbol: 'USDT' as const, address: usdtAddress },
          { symbol: 'USDC' as const, address: usdcAddress },
        ] as const
      ).map(async ({ symbol, address: tokenAddress }) => {
        const erc20 = getErc20(tokenAddress);
        const [rawBalance, protocolBalance] = await Promise.all([
          erc20.balanceOf(poolWallet),
          hntrContract.protocolBalances(poolWallet, tokenAddress),
        ]);
        const walletBal = Number(ethers.formatUnits(rawBalance, amountDecimals));
        const contractBal = Number(ethers.formatUnits(protocolBalance, amountDecimals));
        return {
          symbol,
          address: tokenAddress,
          balance: Number((walletBal + contractBal).toFixed(6)),
        };
      }),
    );

    const totalUSD = tokens.reduce((sum, t) => sum + t.balance, 0);
    return {
      walletAddress: String(poolWallet).toLowerCase(),
      tokens,
      totalUSD: Number(totalUSD.toFixed(2)),
    };
  }

  /** Status payload for the Network page Rank Bonus card. */
  static async getAchievementStatus(walletAddress: string) {
    const address = walletAddress.toLowerCase();
    const user = await User.findOne({ walletAddress: address });
    if (user) {
      const { NetworkService } = await import('./network.service');
      await NetworkService.syncAdminOverrides(user);
    }

    // Fetch after sync so newly enqueued PENDING bonuses show on the Rank Bonus card.
    const bonuses = await AchievementBonus.find({ walletAddress: address })
      .sort({ createdAt: -1 })
      .lean();

    const rankWallet = await hntrContract.rankWallet();
    const walletBalances = await this.getPoolWalletBalances(rankWallet);
    const poolBalanceUSD = walletBalances.totalUSD;

    const lifetimePaidUSD = bonuses
      .filter((b) => b.status === 'PAID')
      .reduce((sum, b) => sum + (b.amountUSD || 0), 0);
    const pendingBonuses = bonuses.filter((b) => b.status === 'PENDING');
    const pendingUSD = pendingBonuses.reduce((sum, b) => sum + (b.amountUSD || 0), 0);
    const hasPending = pendingBonuses.length > 0;
    const hasPaid = lifetimePaidUSD > 0;

    // How much of the pending queue this wallet could cover right now (oldest-first, full amounts only).
    let payableNowUSD = 0;
    let remainingPool = poolBalanceUSD;
    const pendingOldestFirst = [...pendingBonuses].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    for (const b of pendingOldestFirst) {
      if (remainingPool + 1e-9 >= b.amountUSD) {
        payableNowUSD += b.amountUSD;
        remainingPool -= b.amountUSD;
      }
    }
    const waitingOnFundingUSD = Math.max(0, pendingUSD - payableNowUSD);

    const pendingBreakdown = pendingOldestFirst
      .map((b) => `${b.rank} $${Number(b.amountUSD).toFixed(2)}`)
      .join(' + ');

    let message: string;
    if (hasPending) {
      message =
        `$${pendingUSD.toFixed(2)} pending` +
        (pendingBreakdown ? ` (${pendingBreakdown})` : '') +
        `. $${payableNowUSD.toFixed(2)} can pay from the current $${poolBalanceUSD.toFixed(2)} pool` +
        (waitingOnFundingUSD > 0
          ? `; $${waitingOnFundingUSD.toFixed(2)} waits until the achievement wallet is topped up.`
          : '.') +
        ` Paid oldest-first after admin distribute; funding drains USDT first, then USDC.`;
    } else if (hasPaid) {
      message = `$${lifetimePaidUSD.toFixed(2)} lifetime rank bonuses deposited to your wallet.`;
    } else {
      message =
        'No rank bonus yet — reach Scout or above to unlock one-time achievement bonuses.';
    }

    return {
      walletAddress: address,
      username: user?.username || null,
      rank: user?.rank || 'None',
      bonusTable: RANK_ACHIEVEMENT_BONUSES,
      lifetimePaidUSD: Number(lifetimePaidUSD.toFixed(2)),
      pendingUSD: Number(pendingUSD.toFixed(2)),
      payableNowUSD: Number(payableNowUSD.toFixed(2)),
      waitingOnFundingUSD: Number(waitingOnFundingUSD.toFixed(2)),
      hasPending,
      hasPaid,
      message,
      walletBalances,
      poolBalanceUSD,
      bonuses,
      lastBonus: bonuses[0] || null,
    };
  }

  /**
   * Live leadership pool balances + this wallet's share entitlement.
   * Users with 0 shares (below Hunter) get an explicit "no shares" status;
   * users with shares see their weight and an estimated next payout from the
   * current on-chain pool (pro-rata by LEADERSHIP_SHARES).
   */
  static async getLeadershipStatus(walletAddress: string) {
    const address = walletAddress.toLowerCase();
    const user = await User.findOne({ walletAddress: address });
    if (user) {
      const { NetworkService } = await import('./network.service');
      await NetworkService.syncAdminOverrides(user);
    }
    const rank = user?.rank || 'None';
    const shares = getLeadershipShares(rank);
    const hasShares = shares > 0;

    const leadershipWallet = await hntrContract.leadershipWallet();
    const walletBalances = await this.getPoolWalletBalances(leadershipWallet);
    const poolBalanceUSD = walletBalances.totalUSD;

    const eligibleUsers = await User.find({
      rank: { $in: [...LEADERSHIP_ELIGIBLE_RANKS] },
    }).select('rank walletAddress username');

    let totalShares = 0;
    for (const u of eligibleUsers) {
      totalShares += getLeadershipShares(u.rank);
    }

    const estimatedPayoutUSD =
      hasShares && totalShares > 0 ? (shares / totalShares) * poolBalanceUSD : 0;

    const payouts = await Payout.find({ walletAddress: address }).sort({ createdAt: -1 }).lean();
    const lifetimePaidUSD = payouts
      .filter((p) => p.status === 'PAID')
      .reduce((sum, p) => sum + (p.amountUSDC || 0), 0);

    const message = hasShares
      ? `You have ${shares} leadership share${shares === 1 ? '' : 's'} as ${rank}. ` +
        `Est. next payout: $${estimatedPayoutUSD.toFixed(2)} from the current pool.`
      : `You don't have any shares. Reach Hunter rank or above to earn a share of the monthly leadership pool.`;

    return {
      walletAddress: address,
      username: user?.username || null,
      rank,
      shares,
      hasShares,
      totalShares,
      eligibleUserCount: eligibleUsers.length,
      poolBalanceUSD: Number(poolBalanceUSD.toFixed(2)),
      walletBalances,
      estimatedPayoutUSD: Number(estimatedPayoutUSD.toFixed(2)),
      lifetimePaidUSD: Number(lifetimePaidUSD.toFixed(2)),
      shareWeights: LEADERSHIP_SHARES,
      message,
      lastPayout: payouts[0] || null,
      payouts,
    };
  }

  /**
   * Monthly leadership pool distribution from the burner wallet. The admin funds
   * the burner beforehand by connecting the leadership wallet in the admin UI and
   * transferring USDT/USDC to the burner; this method only performs the
   * burner → user payouts.
   */
  static async calculateMonthlyLeadershipPool(triggeredBy = 'system') {
    const leadershipWallet = await hntrContract.leadershipWallet();
    const burner = this.requireBurnerWallet();

    const eligibleUsers = await User.find({
      rank: { $in: [...LEADERSHIP_ELIGIBLE_RANKS] },
    });

    if (eligibleUsers.length === 0) {
      console.log('No users with leadership shares — skipping payouts.');
      return [];
    }

    const burnerPoolsInitial = await this.loadStablecoinPools(burner.address);
    const planningPools = this.clonePools(burnerPoolsInitial);

    planningPools.forEach((p) =>
      console.log(
        `Leadership plan pool ${p.symbol}: $${ethers.formatUnits(p.rawBalance, p.decimals)} (burner)`,
      ),
    );

    const zero = BigInt(0);
    const totalRaw = planningPools.reduce((sum, p) => sum + p.rawBalance, zero);
    if (totalRaw === zero) {
      console.log('Leadership pool is empty — nothing to distribute this month.');
      return [];
    }

    let totalShares = 0;
    const userShares = eligibleUsers.map((u) => {
      const shares = getLeadershipShares(u.rank);
      totalShares += shares;
      return {
        username: u.username,
        walletAddress: u.walletAddress.toLowerCase(),
        rank: u.rank,
        shares,
      };
    });

    if (totalShares === 0) {
      console.log('No users with leadership shares — skipping payouts.');
      return [];
    }

    const currentMonth = new Date().toISOString().slice(0, 7);
    const recipients: PlannedRecipient[] = [];
    let remainingShares = totalShares;
    const workPools = this.clonePools(planningPools);

    for (const userShare of userShares) {
      if (userShare.shares <= 0) continue;

      const existing = await Payout.findOne({ username: userShare.username, month: currentMonth });
      if (existing) {
        console.log(`Skipping ${userShare.username} — already paid for ${currentMonth}`);
        remainingShares -= userShare.shares;
        continue;
      }

      if (remainingShares <= 0) break;

      const remainingRaw = workPools.reduce((sum, p) => sum + p.rawBalance, zero);
      if (remainingRaw <= zero) break;

      const owedRaw = (remainingRaw * BigInt(userShare.shares)) / BigInt(remainingShares);
      if (owedRaw <= zero) {
        remainingShares -= userShare.shares;
        continue;
      }

      // Pay this leader's whole share from a single token — USDT first, else USDC.
      const slice = this.planSingleToken(workPools, owedRaw);
      if (!slice) {
        console.log(
          `Skipping ${userShare.username} — no single token covers their $${ethers.formatUnits(owedRaw, workPools[0].decimals)} share`,
        );
        remainingShares -= userShare.shares;
        continue;
      }

      recipients.push({
        username: userShare.username,
        walletAddress: userShare.walletAddress,
        rank: userShare.rank,
        shares: userShare.shares,
        slices: [
          {
            symbol: slice.pool.symbol,
            tokenAddress: slice.pool.address,
            amountRaw: slice.amountRaw,
            decimals: slice.pool.decimals,
          },
        ],
      });
      this.applySlices([slice]);
      remainingShares -= userShare.shares;
    }

    if (recipients.length === 0) {
      console.log('No unpaid leadership recipients for this month.');
      return [];
    }

    const batch = await DisbursementBatch.create({
      type: 'LEADERSHIP',
      month: currentMonth,
      status: 'DISPERSING',
      triggeredBy,
      protocolWallet: String(leadershipWallet).toLowerCase(),
      burnerWallet: burner.address.toLowerCase(),
      fundTransfers: [],
      dispersals: [],
    });

    try {
      await batch.save();

      const burnerPools = await this.loadStablecoinPools(burner.address);
      const payoutsSaved = [];
      const dispersals: IDispersalEntry[] = [];
      const fundTxHashes: string[] = [];

      for (const recipient of recipients) {
        const breakdown: IPayoutBreakdownEntry[] = [];
        let totalUSD = 0;

        try {
          for (const slice of recipient.slices) {
            const pool = burnerPools.find((p) => p.symbol === slice.symbol);
            if (!pool || pool.rawBalance < slice.amountRaw) {
              throw new Error(`Burner underfunded for ${slice.symbol} mid-dispersion`);
            }
            const amount = Number(ethers.formatUnits(slice.amountRaw, slice.decimals));
            const erc20 = getErc20(slice.tokenAddress).connect(burner) as ethers.Contract;
            const tx = await erc20.transfer(recipient.walletAddress, slice.amountRaw);
            console.log(`  Hop2 ${slice.symbol} ${amount} → ${recipient.walletAddress}: ${tx.hash}`);
            await tx.wait(1);
            pool.rawBalance -= slice.amountRaw;

            breakdown.push({
              symbol: slice.symbol,
              tokenAddress: slice.tokenAddress,
              amount,
              txHash: tx.hash,
              status: 'PAID',
            });
            totalUSD += amount;
            dispersals.push({
              username: recipient.username,
              walletAddress: recipient.walletAddress,
              rank: recipient.rank,
              token: slice.symbol,
              tokenAddress: slice.tokenAddress,
              amountRaw: slice.amountRaw.toString(),
              amount,
              txHash: tx.hash,
              status: 'PAID',
            });
          }
        } catch (e: any) {
          console.error(`Failed hop2 leadership to ${recipient.walletAddress}:`, e.message);
          const paidSymbols = new Set(breakdown.map((b) => b.symbol));
          for (const slice of recipient.slices) {
            if (paidSymbols.has(slice.symbol)) continue;
            breakdown.push({
              symbol: slice.symbol,
              tokenAddress: slice.tokenAddress,
              amount: Number(ethers.formatUnits(slice.amountRaw, slice.decimals)),
              status: 'FAILED',
            });
            dispersals.push({
              username: recipient.username,
              walletAddress: recipient.walletAddress,
              rank: recipient.rank,
              token: slice.symbol,
              tokenAddress: slice.tokenAddress,
              amountRaw: slice.amountRaw.toString(),
              amount: Number(ethers.formatUnits(slice.amountRaw, slice.decimals)),
              status: 'FAILED',
            });
          }
          const refreshed = await this.loadStablecoinPools(burner.address);
          for (const pool of burnerPools) {
            const live = refreshed.find((r) => r.symbol === pool.symbol);
            if (live) pool.rawBalance = live.rawBalance;
          }
        }

        if (breakdown.length === 0) continue;

        const paidEntry = breakdown.find((b) => b.status === 'PAID');
        const newPayout = await Payout.create({
          walletAddress: recipient.walletAddress,
          username: recipient.username,
          rank: recipient.rank,
          amountUSDC: totalUSD,
          shares: recipient.shares || 0,
          txHash: paidEntry?.txHash,
          breakdown,
          month: currentMonth,
          status: paidEntry ? 'PAID' : 'FAILED',
          batchId: String(batch._id),
          fundTxHashes,
        });
        payoutsSaved.push(newPayout);

        if (paidEntry) {
          await NotificationService.createQuiet({
            walletAddress: recipient.walletAddress,
            type: 'LEADERSHIP_PAYOUT',
            title: 'Leadership Bonus deposited',
            sub: `$${totalUSD.toFixed(2)} deposited for ${currentMonth} (${recipient.shares} share${recipient.shares === 1 ? '' : 's'} as ${recipient.rank}).`,
            link: 'VIEW NETWORK',
            meta: {
              month: currentMonth,
              shares: recipient.shares,
              amountUSDC: totalUSD,
              txHash: paidEntry.txHash,
              rank: recipient.rank,
              transfers: breakdown,
              fundTxHashes,
              batchId: String(batch._id),
            },
          });
        }
      }

      batch.dispersals = dispersals;
      const paidCount = payoutsSaved.filter((p) => p.status === 'PAID').length;
      batch.status =
        paidCount === recipients.length ? 'COMPLETED' : paidCount > 0 ? 'PARTIAL' : 'FAILED';
      if (batch.status === 'FAILED') batch.error = 'No leadership payouts completed';
      await batch.save();

      console.log(
        `✅ Leadership two-hop for ${currentMonth}. Created ${payoutsSaved.length} payouts.`,
      );
      return payoutsSaved;
    } catch (err: any) {
      batch.status = 'FAILED';
      batch.error = err?.message || String(err);
      await batch.save();
      throw err;
    }
  }

  /** Every leadership payout a wallet has ever received (most recent first). */
  static async getPayoutHistory(walletAddress: string) {
    return Payout.find({ walletAddress: walletAddress.toLowerCase() }).sort({ createdAt: -1 });
  }

  /** Native ETH + stablecoin snapshot for admin distribute previews. */
  static async getDisbursementWalletHealth(protocolWallet: string) {
    const burner = this.requireBurnerWallet();
    const [protocolEth, burnerEth, protocolPools, burnerPools, protocolCombined] =
      await Promise.all([
        provider.getBalance(protocolWallet),
        provider.getBalance(burner.address),
        this.loadStablecoinPools(protocolWallet),
        this.loadStablecoinPools(burner.address),
        this.getPoolWalletBalances(protocolWallet),
      ]);

    return {
      protocolWallet: String(protocolWallet).toLowerCase(),
      burnerWallet: burner.address.toLowerCase(),
      protocolEth: Number(ethers.formatEther(protocolEth)),
      burnerEth: Number(ethers.formatEther(burnerEth)),
      burnerMinEth: ENV.BURNER_MIN_ETH,
      protocolTokens: protocolPools.map((p) => ({
        symbol: p.symbol,
        balance: Number(ethers.formatUnits(p.rawBalance, p.decimals)),
      })),
      burnerTokens: burnerPools.map((p) => ({
        symbol: p.symbol,
        balance: Number(ethers.formatUnits(p.rawBalance, p.decimals)),
      })),
      protocolCombined,
      hopNote:
        'Step 1: connect the funding wallet and send the burner the "Send to burner" amount — USDT first, then USDC for the rest. Step 2: Distribute pays each recipient entirely in one token (USDT while it lasts, then USDC) — never a mix per recipient.',
    };
  }
}
