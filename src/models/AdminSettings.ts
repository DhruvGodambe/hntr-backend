import mongoose, { Schema, Document } from 'mongoose';

export interface IAdminSettings extends Document {
  key: string;
  maintenanceMode: boolean;
  maintenanceMessage?: string;
  updatedAt: Date;
}

const AdminSettingsSchema: Schema = new Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'global',
    },
    maintenanceMode: {
      type: Boolean,
      default: false,
    },
    maintenanceMessage: {
      type: String,
      maxlength: 512,
      default: 'The platform is temporarily under maintenance. Please check back soon.',
    },
  },
  { timestamps: true },
);

export default mongoose.model<IAdminSettings>('AdminSettings', AdminSettingsSchema);
