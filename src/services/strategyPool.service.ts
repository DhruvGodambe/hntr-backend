import StrategyPool, {
  IStrategyPool,
  IStrategyPoolOpenSea,
  DEFAULT_SEAPORT_PROTOCOL_ADDRESS,
} from '../models/StrategyPool';

export class PoolServiceError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

export interface PoolOpenSeaInput {
  collectionSlug?: string;
  contractAddress?: string;
  chain?: string;
  tokenStandard?: string;
  protocolAddress?: string;
  trait?: { type?: string; value?: string } | null;
  offerProtectionEnabled?: boolean;
}

export interface PoolEconomicsInput {
  raisedEth?: number;
  gpProfit?: string;
  ethProfit?: string;
  usdtProfit?: string;
  participants?: number;
  daysRemaining?: number;
  tags?: string[] | string;
}

/**
 * Validate + normalize the OpenSea binding block that admins submit. Returns
 * `undefined` when no OpenSea fields are present so whole records without a
 * collection binding are still allowed.
 */
export function normalizeOpenSea(input: PoolOpenSeaInput | undefined | null): IStrategyPoolOpenSea | undefined {
  if (!input || typeof input !== 'object') return undefined;

  const collectionSlug = typeof input.collectionSlug === 'string' ? input.collectionSlug.trim() : '';
  const contractAddress = typeof input.contractAddress === 'string' ? input.contractAddress.trim() : '';
  const chain = typeof input.chain === 'string' && input.chain.trim() ? input.chain.trim() : 'ethereum';

  const hasAny =
    collectionSlug ||
    contractAddress ||
    input.tokenStandard ||
    input.protocolAddress ||
    input.trait ||
    input.offerProtectionEnabled !== undefined;
  if (!hasAny) return undefined;

  if (!collectionSlug) {
    throw new PoolServiceError('OPENSEA_SLUG_REQUIRED', 'openSea.collectionSlug is required when an OpenSea binding is provided.');
  }
  if (contractAddress && !ADDR_RE.test(contractAddress)) {
    throw new PoolServiceError('OPENSEA_BAD_CONTRACT', 'openSea.contractAddress must be a 0x-prefixed 40-hex address.');
  }
  if (input.tokenStandard && !['erc721', 'erc1155'].includes(input.tokenStandard)) {
    throw new PoolServiceError('OPENSEA_BAD_STANDARD', 'openSea.tokenStandard must be erc721 or erc1155.');
  }

  let trait: { type: string; value: string } | undefined;
  const traitType = input.trait?.type?.trim();
  const traitValue = input.trait?.value?.trim();
  if (traitType || traitValue) {
    if (!traitType || !traitValue) {
      throw new PoolServiceError('OPENSEA_BAD_TRAIT', 'openSea.trait requires both type and value, or neither.');
    }
    trait = { type: traitType, value: traitValue };
  }

  return {
    collectionSlug,
    contractAddress: contractAddress || undefined,
    chain,
    tokenStandard: input.tokenStandard as 'erc721' | 'erc1155' | undefined,
    protocolAddress:
      typeof input.protocolAddress === 'string' && input.protocolAddress.trim()
        ? input.protocolAddress.trim()
        : DEFAULT_SEAPORT_PROTOCOL_ADDRESS,
    trait,
    offerProtectionEnabled: input.offerProtectionEnabled ?? true,
  };
}

export function normalizeTags(tags: string[] | string | undefined): string[] | undefined {
  if (tags === undefined) return undefined;
  const arr = Array.isArray(tags) ? tags : String(tags).split(',');
  const cleaned = arr.map((t) => String(t).trim()).filter(Boolean).slice(0, 8);
  return cleaned.length ? cleaned : undefined;
}

export interface PublicPool {
  slug: string;
  name: string;
  imageUrl: string;
  raisedEth: number;
  status: 'OPEN' | 'CLOSED' | 'COMPLETED';
  depositsPaused: boolean;
  collectionName?: string;
  openSea?: {
    collectionSlug: string;
    contractAddress?: string;
    chain: string;
    tokenStandard?: string;
    trait?: { type: string; value: string };
  };
  /** Economics default to 0 until the pool goes live. */
  gpProfit: string;
  ethProfit: string;
  usdtProfit: string;
  participants: number;
  daysRemaining: number;
  tags?: string[];
  updatedAt?: Date;
}

export function toPublicPool(p: IStrategyPool | Record<string, any>): PublicPool {
  return {
    slug: p.slug,
    name: p.name,
    imageUrl: p.imageUrl,
    raisedEth: p.raisedEth,
    status: p.status,
    depositsPaused: p.depositsPaused,
    collectionName: p.collectionName,
    openSea: p.openSea
      ? {
          collectionSlug: p.openSea.collectionSlug,
          contractAddress: p.openSea.contractAddress,
          chain: p.openSea.chain,
          tokenStandard: p.openSea.tokenStandard,
          trait: p.openSea.trait,
        }
      : undefined,
    gpProfit: p.gpProfit ?? '0',
    ethProfit: p.ethProfit ?? '0',
    usdtProfit: p.usdtProfit ?? '0',
    participants: p.participants ?? 0,
    daysRemaining: p.daysRemaining ?? 0,
    tags: p.tags,
    updatedAt: p.updatedAt,
  };
}

export class StrategyPoolService {
  static async getPublicPools(): Promise<PublicPool[]> {
    const pools = await StrategyPool.find({ status: { $ne: 'CLOSED' } })
      .sort({ status: 1, createdAt: -1 })
      .lean();
    return pools.map(toPublicPool);
  }

  static async getPublicPoolBySlug(slug: string): Promise<PublicPool> {
    const pool = await StrategyPool.findOne({ slug }).lean();
    if (!pool) throw new PoolServiceError('POOL_NOT_FOUND', 'Strategy pool not found.', 404);
    return toPublicPool(pool);
  }

  /**
   * Assemble the request body for OpenSea `POST /api/v2/offers/build`. Pure
   * assembly from the stored binding — no network call.
   */
  static async buildOfferPayload(slug: string, offerer: string, quantity = 1) {
    if (!offerer || !ADDR_RE.test(offerer)) {
      throw new PoolServiceError('BAD_OFFERER', 'offerer must be a 0x-prefixed 40-hex address.');
    }
    const pool = await StrategyPool.findOne({ slug }).lean();
    if (!pool) throw new PoolServiceError('POOL_NOT_FOUND', 'Strategy pool not found.', 404);
    if (!pool.openSea?.collectionSlug) {
      throw new PoolServiceError('POOL_NOT_BOUND', 'This pool has no OpenSea collection binding.', 409);
    }

    const os = pool.openSea;
    const criteria: Record<string, unknown> = {
      collection: { slug: os.collectionSlug },
    };
    if (os.contractAddress) criteria.contract = { address: os.contractAddress };
    if (os.trait) criteria.trait = { type: os.trait.type, value: os.trait.value };

    const qty = Number.isFinite(quantity) && quantity >= 1 ? Math.floor(quantity) : 1;

    return {
      openSeaEndpoint: 'POST https://api.opensea.io/api/v2/offers/build',
      proxyPath: 'offers/build',
      chain: os.chain,
      body: {
        criteria,
        offerer,
        protocol_address: os.protocolAddress || DEFAULT_SEAPORT_PROTOCOL_ADDRESS,
        quantity: qty,
        offer_protection_enabled: os.offerProtectionEnabled ?? true,
      },
    };
  }
}
