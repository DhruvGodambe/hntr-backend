import mongoose, { Schema, Document } from 'mongoose';

/** open = waiting on support · pending = support replied, waiting on the member · resolved = closed by support. */
export type SupportTicketStatus = 'open' | 'pending' | 'resolved';
export type SupportTicketPriority = 'Low' | 'Normal' | 'Urgent';

export interface ISupportMessage {
  fromSupport: boolean;
  body: string;
  /** Admin username for support replies; never sent to members. */
  author?: string;
  createdAt: Date;
}

export interface ISupportTicket extends Document {
  /** Public id is `HNT-<ticketNumber>`. */
  ticketNumber: number;
  walletAddress: string;
  /** Username at the time the ticket was opened (unregistered wallets have none). */
  username?: string;
  category: string;
  priority: SupportTicketPriority;
  strategy?: string;
  subject: string;
  status: SupportTicketStatus;
  /** Screenshots the member selected. Files are not stored yet; support asks for them in a reply. */
  attachmentCount: number;
  messages: ISupportMessage[];
  lastMessageAt: Date;
  resolvedAt?: Date;
  resolvedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const SupportMessageSchema = new Schema<ISupportMessage>(
  {
    fromSupport: { type: Boolean, required: true },
    body: { type: String, required: true, maxlength: 5000 },
    author: { type: String },
    createdAt: { type: Date, required: true },
  },
  { _id: false },
);

const SupportTicketSchema: Schema = new Schema(
  {
    ticketNumber: { type: Number, required: true },
    walletAddress: { type: String, required: true, lowercase: true },
    username: { type: String },
    category: { type: String, required: true, maxlength: 64 },
    priority: { type: String, enum: ['Low', 'Normal', 'Urgent'], default: 'Normal' },
    strategy: { type: String, maxlength: 100 },
    subject: { type: String, required: true, maxlength: 90 },
    status: { type: String, enum: ['open', 'pending', 'resolved'], default: 'open' },
    attachmentCount: { type: Number, default: 0, min: 0 },
    messages: { type: [SupportMessageSchema], default: [] },
    lastMessageAt: { type: Date, required: true },
    resolvedAt: { type: Date },
    resolvedBy: { type: String },
  },
  { timestamps: true },
);

SupportTicketSchema.index({ ticketNumber: 1 }, { unique: true });
SupportTicketSchema.index({ walletAddress: 1, lastMessageAt: -1 });
SupportTicketSchema.index({ status: 1, lastMessageAt: -1 });

export default mongoose.model<ISupportTicket>('SupportTicket', SupportTicketSchema);
