import Notification, { INotification, NotificationType } from '../models/Notification';

export interface CreateNotificationInput {
  walletAddress: string;
  type: NotificationType;
  title: string;
  sub: string;
  link?: string;
  meta?: Record<string, unknown>;
}

export class NotificationService {
  static async create(input: CreateNotificationInput): Promise<INotification> {
    return Notification.create({
      walletAddress: input.walletAddress.toLowerCase(),
      type: input.type,
      title: input.title,
      sub: input.sub,
      link: input.link,
      meta: input.meta,
      read: false,
      createdAt: new Date(),
    });
  }

  static async createQuiet(input: CreateNotificationInput): Promise<INotification | null> {
    try {
      return await this.create(input);
    } catch (err: any) {
      console.error('Failed to create notification:', err?.message || err);
      return null;
    }
  }

  static async listForWallet(walletAddress: string, limit = 50) {
    const address = walletAddress.toLowerCase();
    const notifications = await Notification.find({ walletAddress: address })
      .sort({ createdAt: -1 })
      .limit(Math.min(limit, 100))
      .lean();

    const unreadCount = await Notification.countDocuments({ walletAddress: address, read: false });

    return { notifications, unreadCount };
  }

  static async markRead(walletAddress: string, ids?: string[]) {
    const address = walletAddress.toLowerCase();
    const filter: Record<string, unknown> = { walletAddress: address, read: false };
    if (ids?.length) {
      filter._id = { $in: ids };
    }
    const result = await Notification.updateMany(filter, { $set: { read: true } });
    return { modified: result.modifiedCount };
  }
}
