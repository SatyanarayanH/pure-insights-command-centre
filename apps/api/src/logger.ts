import pino, { type Logger } from 'pino';
import type { Config } from './config.js';

export type { Logger };

export function createLogger(config: Pick<Config, 'env' | 'logLevel'>): Logger {
  return pino({
    level: config.env === 'test' ? 'silent' : config.logLevel,
    // Never let a credential reach the logs, whatever a caller passes in.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        '*.password',
        '*.token',
      ],
      censor: '[redacted]',
    },
    ...(config.env === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}
