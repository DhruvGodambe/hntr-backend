import { Request, Response, NextFunction } from 'express';
import { logInbound } from '../utils/httpLog';

function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/** One decorated line per inbound request: method, URL, coloured status, duration. */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now();

  res.on('finish', () => {
    logInbound(req.method, req.originalUrl, res.statusCode, Date.now() - started, clientIp(req));
  });

  next();
}
