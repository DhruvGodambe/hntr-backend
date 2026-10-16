import SupportTicket, {
  ISupportMessage,
  ISupportTicket,
  SupportTicketPriority,
  SupportTicketStatus,
} from '../models/SupportTicket';
import Counter from '../models/Counter';
import User from '../models/User';
import { NotificationService } from './notification.service';
import { parsePagination, paginatedResponse, sanitizeSearch } from '../utils/pagination';
import { logger } from '../utils/logger';

export class SupportError extends Error {
  code: string;
  statusCode: number;
  constructor(codeName: string, message: string, statusCode = 400) {
    super(message);
    this.code = codeName;
    this.statusCode = statusCode;
  }
}

/** Must match the category list on the frontend Support page. */
export const SUPPORT_CATEGORIES = [
  'Deposits & Withdrawals',
  'NFT Strategies',
  'Membership',
  'Network & Rewards',
  'Wallet & Account',
  'Other',
] as const;
export const SUPPORT_PRIORITIES: SupportTicketPriority[] = ['Low', 'Normal', 'Urgent'];
const STATUSES: SupportTicketStatus[] = ['open', 'pending', 'resolved'];

const COUNTER_KEY = 'supportTicket';
/** First ticket is HNT-1001. */
const TICKET_BASE = 1000;
const ID_RE = /^HNT-(\d{1,9})$/i;
const SUBJECT_MAX = 90;
const BODY_MAX = 5000;
const STRATEGY_MAX = 100;
const MAX_ATTACHMENTS = 10;
/** Unresolved tickets one wallet may hold at once. */
const MAX_OPEN_PER_WALLET = 10;
/** Messages per ticket, so one thread can't grow without bound. */
const MAX_MESSAGES = 200;
const MEMBER_LIST_LIMIT = 50;

export interface SupportMessageDto {
  fromSupport: boolean;
  body: string;
  createdAt: Date;
}

export interface SupportTicketDto {
  id: string;
  subject: string;
  category: string;
  priority: SupportTicketPriority;
  strategy: string | null;
  status: SupportTicketStatus;
  createdAt: Date;
  messages: SupportMessageDto[];
}

type TicketRow = Pick<
  ISupportTicket,
  | 'ticketNumber'
  | 'walletAddress'
  | 'username'
  | 'category'
  | 'priority'
  | 'strategy'
  | 'subject'
  | 'status'
  | 'attachmentCount'
  | 'messages'
  | 'lastMessageAt'
  | 'resolvedAt'
  | 'resolvedBy'
  | 'createdAt'
>;

function publicId(ticketNumber: number): string {
  return `HNT-${ticketNumber}`;
}

function parseId(raw: string): number {
  const m = ID_RE.exec(String(raw ?? '').trim());
  if (!m) throw new SupportError('INVALID_TICKET', 'Invalid ticket id', 400);
  return Number(m[1]);
}

function text(raw: unknown, field: string, max: number): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) throw new SupportError('INVALID_INPUT', `${field} is required`);
  if (value.length > max) throw new SupportError('INVALID_INPUT', `${field} must be ${max} characters or fewer`);
  return value;
}

/** Member view: support replies stay anonymous ("HNTR Support"), admin names never leave the server. */
function toDto(t: TicketRow): SupportTicketDto {
  return {
    id: publicId(t.ticketNumber),
    subject: t.subject,
    category: t.category,
    priority: t.priority,
    strategy: t.strategy || null,
    status: t.status,
    createdAt: t.createdAt,
    messages: (t.messages ?? []).map((m) => ({ fromSupport: m.fromSupport, body: m.body, createdAt: m.createdAt })),
  };
}

/** Admin view: adds the member, attachment count and who wrote each support reply. */
function toAdminDto(t: TicketRow) {
  return {
    ...toDto(t),
    walletAddress: t.walletAddress,
    username: t.username ?? null,
    attachmentCount: t.attachmentCount ?? 0,
    lastMessageAt: t.lastMessageAt,
    resolvedAt: t.resolvedAt ?? null,
    resolvedBy: t.resolvedBy ?? null,
    messages: (t.messages ?? []).map((m) => ({
      fromSupport: m.fromSupport,
      body: m.body,
      author: m.fromSupport ? (m.author ?? null) : null,
      createdAt: m.createdAt,
    })),
  };
}

export class SupportService {
  // ── member ───────────────────────────────────────────────────────────────

  static async createTicket(walletAddress: string, input: Record<string, unknown>): Promise<SupportTicketDto> {
    const wallet = walletAddress.toLowerCase();

    const category = text(input.category, 'Category', 64);
    if (!(SUPPORT_CATEGORIES as readonly string[]).includes(category)) {
      throw new SupportError('INVALID_CATEGORY', 'Choose a category from the list');
    }
    const priority = String(input.priority ?? 'Normal') as SupportTicketPriority;
    if (!SUPPORT_PRIORITIES.includes(priority)) throw new SupportError('INVALID_PRIORITY', 'Priority must be Low, Normal or Urgent');
    const subject = text(input.subject, 'Subject', SUBJECT_MAX);
    const body = text(input.message, 'Message', BODY_MAX);
    const strategy = typeof input.strategy === 'string' ? input.strategy.trim().slice(0, STRATEGY_MAX) : '';
    const rawCount = Number(input.attachmentCount ?? 0);
    const attachmentCount = Number.isFinite(rawCount) ? Math.min(Math.max(Math.floor(rawCount), 0), MAX_ATTACHMENTS) : 0;

    const openCount = await SupportTicket.countDocuments({ walletAddress: wallet, status: { $in: ['open', 'pending'] } });
    if (openCount >= MAX_OPEN_PER_WALLET) {
      throw new SupportError(
        'TOO_MANY_OPEN_TICKETS',
        `You already have ${MAX_OPEN_PER_WALLET} open tickets. Reply on one of those, or wait until they are resolved.`,
        429,
      );
    }

    const user = await User.findOne({ walletAddress: wallet }).select('username').lean();
    const counter = await Counter.findOneAndUpdate({ key: COUNTER_KEY }, { $inc: { seq: 1 } }, { upsert: true, new: true });
    const ticketNumber = TICKET_BASE + counter.seq;
    const now = new Date();

    const doc = await SupportTicket.create({
      ticketNumber,
      walletAddress: wallet,
      username: user?.username,
      category,
      priority,
      strategy: strategy || undefined,
      subject,
      status: 'open',
      attachmentCount,
      messages: [{ fromSupport: false, body, createdAt: now }],
      lastMessageAt: now,
    });
    logger.info(`Support ticket ${publicId(ticketNumber)} opened by ${wallet} (${category}, ${priority})`);
    return toDto(doc);
  }

  static async listMine(walletAddress: string): Promise<SupportTicketDto[]> {
    const rows = await SupportTicket.find({ walletAddress: walletAddress.toLowerCase() })
      .sort({ lastMessageAt: -1 })
      .limit(MEMBER_LIST_LIMIT)
      .lean<TicketRow[]>();
    return rows.map(toDto);
  }

  /** A member reply re-opens the ticket for support. Resolved tickets are closed to replies. */
  static async replyAsMember(walletAddress: string, ticketId: string, rawBody: unknown): Promise<SupportTicketDto> {
    const wallet = walletAddress.toLowerCase();
    const ticketNumber = parseId(ticketId);
    const body = text(rawBody, 'Reply', BODY_MAX);
    const now = new Date();
    const message: ISupportMessage = { fromSupport: false, body, createdAt: now };

    const doc = await SupportTicket.findOneAndUpdate(
      {
        ticketNumber,
        walletAddress: wallet,
        status: { $in: ['open', 'pending'] },
        [`messages.${MAX_MESSAGES - 1}`]: { $exists: false },
      },
      { $push: { messages: message }, $set: { status: 'open', lastMessageAt: now } },
      { new: true },
    ).lean<TicketRow>();
    if (doc) return toDto(doc);

    const existing = await SupportTicket.findOne({ ticketNumber, walletAddress: wallet }).lean<TicketRow>();
    if (!existing) throw new SupportError('TICKET_NOT_FOUND', 'Ticket not found', 404);
    if (existing.status === 'resolved') {
      throw new SupportError('TICKET_RESOLVED', 'This ticket is resolved. Open a new ticket if you still need help.', 409);
    }
    throw new SupportError('TICKET_FULL', 'This conversation is too long. Please open a new ticket.', 409);
  }

  // ── admin ────────────────────────────────────────────────────────────────

  /** `status`: open | pending | resolved | active (open + pending, the default) | all. `search`: id, username, wallet or subject. */
  static async adminList(query: Record<string, unknown>) {
    const { page, limit, skip } = parsePagination(query);
    const status = String(query.status ?? 'active');
    const filter: Record<string, any> = {};
    if ((STATUSES as string[]).includes(status)) filter.status = status;
    else if (status !== 'all') filter.status = { $in: ['open', 'pending'] };

    const search = sanitizeSearch(query.search);
    if (search) {
      const idMatch = ID_RE.exec(search.replace(/\\/g, ''));
      const re = new RegExp(search, 'i');
      filter.$or = [
        ...(idMatch ? [{ ticketNumber: Number(idMatch[1]) }] : []),
        { username: re },
        { walletAddress: re },
        { subject: re },
      ];
    }

    const [rows, total] = await Promise.all([
      SupportTicket.find(filter).sort({ lastMessageAt: -1 }).skip(skip).limit(limit).lean<TicketRow[]>(),
      SupportTicket.countDocuments(filter),
    ]);
    return paginatedResponse(rows.map(toAdminDto), total, page, limit);
  }

  static async adminGet(ticketId: string) {
    const doc = await SupportTicket.findOne({ ticketNumber: parseId(ticketId) }).lean<TicketRow>();
    if (!doc) throw new SupportError('TICKET_NOT_FOUND', 'Ticket not found', 404);
    return toAdminDto(doc);
  }

  /** A support reply hands the ticket back to the member (pending) and re-opens it if it was resolved. */
  static async adminReply(ticketId: string, adminUsername: string, rawBody: unknown) {
    const ticketNumber = parseId(ticketId);
    const body = text(rawBody, 'Reply', BODY_MAX);
    const now = new Date();
    const message: ISupportMessage = { fromSupport: true, body, author: adminUsername, createdAt: now };

    const doc = await SupportTicket.findOneAndUpdate(
      { ticketNumber, [`messages.${MAX_MESSAGES - 1}`]: { $exists: false } },
      {
        $push: { messages: message },
        $set: { status: 'pending', lastMessageAt: now },
        $unset: { resolvedAt: '', resolvedBy: '' },
      },
      { new: true },
    ).lean<TicketRow>();
    if (!doc) {
      const exists = await SupportTicket.findOne({ ticketNumber }).lean<TicketRow>();
      if (!exists) throw new SupportError('TICKET_NOT_FOUND', 'Ticket not found', 404);
      throw new SupportError('TICKET_FULL', 'This conversation has reached its message limit.', 409);
    }

    logger.info(`Support ticket ${publicId(ticketNumber)} answered by ${adminUsername}`);
    await NotificationService.createQuiet({
      walletAddress: doc.walletAddress,
      type: 'SUPPORT_REPLY',
      title: `Support replied — ${publicId(ticketNumber)}`,
      sub: doc.subject,
      link: `/support?ticket=${publicId(ticketNumber)}`,
      meta: { ticketId: publicId(ticketNumber) },
      dedupeKey: `SUPPORT_REPLY:${ticketNumber}:${now.getTime()}`,
    });
    return toAdminDto(doc);
  }

  static async adminSetStatus(ticketId: string, adminUsername: string, rawStatus: unknown) {
    const ticketNumber = parseId(ticketId);
    const status = String(rawStatus ?? '') as SupportTicketStatus;
    if (!STATUSES.includes(status)) throw new SupportError('INVALID_STATUS', 'Status must be open, pending or resolved');

    const update =
      status === 'resolved'
        ? { $set: { status, resolvedAt: new Date(), resolvedBy: adminUsername } }
        : { $set: { status }, $unset: { resolvedAt: '', resolvedBy: '' } };
    const doc = await SupportTicket.findOneAndUpdate({ ticketNumber }, update, { new: true }).lean<TicketRow>();
    if (!doc) throw new SupportError('TICKET_NOT_FOUND', 'Ticket not found', 404);

    logger.info(`Support ticket ${publicId(ticketNumber)} set to ${status} by ${adminUsername}`);
    return toAdminDto(doc);
  }
}
