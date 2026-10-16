import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { ENV } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Private image storage for support screenshots. Everything is uploaded as an
 * "authenticated" asset, so the plain delivery URL is refused; viewers get a
 * short-lived signed download URL from `signedUrl` instead.
 */

export interface StoredImage {
  publicId: string;
  format: string;
  bytes: number;
  width: number;
  height: number;
}

let configured = false;

export function isCloudinaryConfigured(): boolean {
  return !!(ENV.CLOUDINARY_CLOUD_NAME && ENV.CLOUDINARY_API_KEY && ENV.CLOUDINARY_API_SECRET);
}

function client() {
  if (!configured) {
    cloudinary.config({
      cloud_name: ENV.CLOUDINARY_CLOUD_NAME,
      api_key: ENV.CLOUDINARY_API_KEY,
      api_secret: ENV.CLOUDINARY_API_SECRET,
      secure: true,
    });
    configured = true;
  }
  return cloudinary;
}

/**
 * Startup check: pings Cloudinary with the configured keys and logs the result.
 * Never throws; a failure only disables screenshot uploads, not the server.
 */
export async function verifyCloudinary(): Promise<void> {
  if (!isCloudinaryConfigured()) {
    logger.warn('Cloudinary not configured (CLOUDINARY_* env vars missing) — support screenshot uploads are disabled');
    return;
  }
  // Only ever log a plain cloud name, so a mis-pasted value can't leak the API secret into logs.
  const cloud = /^[\w-]{1,64}$/.test(ENV.CLOUDINARY_CLOUD_NAME) ? ENV.CLOUDINARY_CLOUD_NAME : '(invalid cloud name)';
  try {
    await client().api.ping();
    logger.info(`Cloudinary initialised successfully (cloud "${cloud}", folder "${ENV.CLOUDINARY_FOLDER}")`);
  } catch (err: any) {
    const reason = err?.error?.message || err?.message || String(err);
    logger.error(`Cloudinary initialisation failed for cloud "${cloud}": ${reason} — uploads will fail until fixed`);
  }
}

export async function uploadPrivateImage(buffer: Buffer, folder: string): Promise<StoredImage> {
  const res = await new Promise<UploadApiResponse>((resolve, reject) => {
    const stream = client().uploader.upload_stream(
      { folder, type: 'authenticated', resource_type: 'image', overwrite: false },
      (err, result) => (err || !result ? reject(err ?? new Error('Empty Cloudinary response')) : resolve(result)),
    );
    stream.end(buffer);
  });
  return { publicId: res.public_id, format: res.format, bytes: res.bytes, width: res.width, height: res.height };
}

/** Download URL for a private image, valid for `ttlSec` seconds. */
export function signedUrl(publicId: string, format: string, ttlSec = 600): string {
  return client().utils.private_download_url(publicId, format, {
    type: 'authenticated',
    resource_type: 'image',
    expires_at: Math.floor(Date.now() / 1000) + ttlSec,
  });
}

/** Best-effort delete, used to clean up when a DB write fails after an upload. */
export async function deleteImage(publicId: string): Promise<void> {
  try {
    await client().uploader.destroy(publicId, { type: 'authenticated', resource_type: 'image', invalidate: true });
  } catch (err: any) {
    logger.warn(`Cloudinary: could not delete ${publicId}: ${err?.message || err}`);
  }
}
