import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { sendError } from '../utils/response';
import { MAX_ATTACHMENT_BYTES } from '../services/support.service';

const MAX_FILES = 10;

const screenshotUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: MAX_FILES, fields: 5 },
}).array('files', MAX_FILES);

/**
 * Parses `multipart/form-data` with up to 10 images in the `files` field into memory
 * (req.files). File contents are type-checked later in the service, not here.
 */
export function supportScreenshots(req: Request, res: Response, next: NextFunction): void {
  screenshotUpload(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        sendError(res, 'Each screenshot must be 5 MB or smaller', 413, { code: 'FILE_TOO_LARGE' });
        return;
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        sendError(res, `Send up to ${MAX_FILES} screenshots in the "files" field`, 400, { code: 'TOO_MANY_FILES' });
        return;
      }
      sendError(res, 'Invalid upload', 400, { code: 'INVALID_UPLOAD' });
      return;
    }
    next(err);
  });
}
