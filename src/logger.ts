/**
 * Proton Drive Sync - Logger
 *
 * Logs to both file and console by default.
 * In daemon mode, console logging is disabled.
 */

import winston from 'winston';
import { STATE_DIR } from './db/index.js';

const LOG_FILE = `${STATE_DIR}/sync.log`;

export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.File({ filename: LOG_FILE }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message }) => `${level}: ${message}`)
      ),
    }),
  ],
});

/**
 * Disable console logging (for daemon mode - background process)
 */
export function disableConsoleLogging(): void {
  logger.transports.forEach((transport) => {
    if (transport instanceof winston.transports.Console) {
      transport.silent = true;
    }
  });
}

/**
 * Enable debug level logging
 */
export function enableDebug(): void {
  logger.level = 'debug';
}
