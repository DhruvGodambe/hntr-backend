import SupportTicket, {
  ISupportAttachment,
  ISupportMessage,
  ISupportTicket,
  SupportTicketPriority,
  SupportTicketStatus,
} from '../models/SupportTicket';
import Counter from '../models/Counter';
import User from '../models/User';
import { NotificationService } from './notification.service';
import { deleteImage, isCloudinaryConfigured, signedUrl, uploadPrivateImage } from './cloudinary.service';
import { ENV } from '../config/env';
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
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Signed screenshot URLs stay valid this long; clients refetch the ticket to refresh them. */
const ATTACHMENT_URL_TTL_SEC = 10 * 60;
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

export interface SupportAttachmentDto {
  /** Signed download URL, expires after ~10 minutes. Null if storage is not configured. */
  url: string | null;
  format: string;
  bytes: number;
  width: number;
  height: number;
  fromSupport: boolean;
  uploadedAt: Date;
}

/** An uploaded file as handed over by the multipart middleware. */
export interface UploadedFile {
  buffer: Buffer;
  size: number;
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
  attachments: SupportAttachmentDto[];
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
  | 'attachments'
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

/** Image type from the file's first bytes; the client's filename and mimetype are not trusted. */
export function sniffImageFormat(buf: Buffer): 'png' | 'jpg' | 'gif' | 'webp' | null {
  const ascii = (from: number, to: number) => buf.subarray(from, to).toString('latin1');
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'gif';
  if (buf.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}

function toAttachmentDto(a: ISupportAttachment): SupportAttachmentDto {
  return {
    url: isCloudinaryConfigured() ? signedUrl(a.publicId, a.format, ATTACHMENT_URL_TTL_SEC) : null,
    format: a.format,
    bytes: a.bytes,
    width: a.width,
    height: a.height,
    fromSupport: a.fromSupport,
    uploadedAt: a.uploadedAt,
  };
}

function checkFiles(files: UploadedFile[] | undefined): UploadedFile[] {
  const list = files ?? [];
  if (!list.length) throw new SupportError('NO_FILES', 'Choose at least one screenshot');
  if (list.length > MAX_ATTACHMENTS) {
    throw new SupportError('TOO_MANY_FILES', `You can attach up to ${MAX_ATTACHMENTS} screenshots per ticket`);
  }
  for (const f of list) {
    if (f.size > MAX_ATTACHMENT_BYTES) throw new SupportError('FILE_TOO_LARGE', 'Each screenshot must be 5 MB or smaller', 413);
    if (!sniffImageFormat(f.buffer)) {
      throw new SupportError('INVALID_FILE_TYPE', 'Screenshots must be PNG, JPEG, GIF or WebP images');
    }
  }
  if (!isCloudinaryConfigured()) {
    throw new SupportError('UPLOADS_NOT_CONFIGURED', 'Screenshot uploads are not available right now', 503);
  }
  return list;
}

/**
 * Uploads the files, then appends them in one guarded update so a ticket never holds more than
 * MAX_ATTACHMENTS, even with concurrent uploads. The files are deleted again if the update misses.
 */
async function storeAttachments(
  ticketNumber: number,
  filter: Record<string, unknown>,
  files: UploadedFile[],
  fromSupport: boolean,
): Promise<TicketRow | null> {
  const folder = `${ENV.CLOUDINARY_FOLDER}/${publicId(ticketNumber)}`;
  const settled = await Promise.allSettled(files.map((f) => uploadPrivateImage(f.buffer, folder)));
  const stored = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  if (stored.length !== files.length) {
    await Promise.all(stored.map((img) => deleteImage(img.publicId)));
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    logger.error(`Support ${publicId(ticketNumber)}: screenshot upload failed: ${failed?.reason?.message || failed?.reason}`);
    throw new SupportError('UPLOAD_FAILED', 'Could not upload the screenshots. Please try again.', 502);
  }

  const now = new Date();
  const items: ISupportAttachment[] = stored.map((img) => ({ ...img, fromSupport, uploadedAt: now }));
  const doc = await SupportTicket.findOneAndUpdate(
    { ...filter, ticketNumber, [`attachments.${MAX_ATTACHMENTS - files.length}`]: { $exists: false } },
    { $push: { attachments: { $each: items } } },
    { new: true },
  ).lean<TicketRow>();
  if (!doc) await Promise.all(stored.map((img) => deleteImage(img.publicId)));
  return doc;
}

function tooMany(ticket: TicketRow): never {
  const left = Math.max(0, MAX_ATTACHMENTS - (ticket.attachments?.length ?? 0));
  throw new SupportError(
    'TOO_MANY_FILES',
    left
      ? `This ticket can take ${left} more screenshot${left === 1 ? '' : 's'}`
      : `This ticket already has ${MAX_ATTACHMENTS} screenshots`,
    409,
  );
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
    attachments: (t.attachments ?? []).map(toAttachmentDto),
  };
}

/** Admin view: adds the member, attachment count and who wrote each support reply. */
function toAdminDto(t: TicketRow) {
  return {
    ...toDto(t),
    walletAddress: t.walletAddress,
    username: t.username ?? null,
    attachmentCount: Math.max(t.attachmentCount ?? 0, t.attachments?.length ?? 0),
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

  /** Adds screenshots to one of the member's own tickets. Resolved tickets are closed to uploads. */
  static async addMemberAttachments(
    walletAddress: string,
    ticketId: string,
    rawFiles: UploadedFile[] | undefined,
  ): Promise<SupportTicketDto> {
    const wallet = walletAddress.toLowerCase();
    const ticketNumber = parseId(ticketId);
    const files = checkFiles(rawFiles);
    const resolved = () =>
      new SupportError('TICKET_RESOLVED', 'This ticket is resolved. Open a new ticket if you still need help.', 409);

    const existing = await SupportTicket.findOne({ ticketNumber, walletAddress: wallet }).lean<TicketRow>();
    if (!existing) throw new SupportError('TICKET_NOT_FOUND', 'Ticket not found', 404);
    if (existing.status === 'resolved') throw resolved();
    if ((existing.attachments?.length ?? 0) + files.length > MAX_ATTACHMENTS) tooMany(existing);

    const doc = await storeAttachments(
      ticketNumber,
      { walletAddress: wallet, status: { $in: ['open', 'pending'] } },
      files,
      false,
    );
    if (!doc) {
      // Lost a race: resolved meanwhile, or another upload filled the slots.
      const latest = await SupportTicket.findOne({ ticketNumber, walletAddress: wallet }).lean<TicketRow>();
      if (latest?.status === 'resolved') throw resolved();
      tooMany(latest ?? existing);
    }
    logger.info(`Support ticket ${publicId(ticketNumber)}: ${files.length} screenshot(s) added by ${wallet}`);
    return toDto(doc);
  }

  // ── admin ────────────────────────────────────────────────────────────────

  /** Support attaches screenshots to a ticket (any status). */
  static async adminAddAttachments(ticketId: string, adminUsername: string, rawFiles: UploadedFile[] | undefined) {
    const ticketNumber = parseId(ticketId);
    const files = checkFiles(rawFiles);

    const existing = await SupportTicket.findOne({ ticketNumber }).lean<TicketRow>();
    if (!existing) throw new SupportError('TICKET_NOT_FOUND', 'Ticket not found', 404);
    if ((existing.attachments?.length ?? 0) + files.length > MAX_ATTACHMENTS) tooMany(existing);

    const doc = await storeAttachments(ticketNumber, {}, files, true);
    if (!doc) tooMany((await SupportTicket.findOne({ ticketNumber }).lean<TicketRow>()) ?? existing);
    logger.info(`Support ticket ${publicId(ticketNumber)}: ${files.length} screenshot(s) added by ${adminUsername}`);
    return toAdminDto(doc);
  }

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
