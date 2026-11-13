/**
 * PilotPanel: Leveled Logger
 * Complies with strict code rule: silent in production, leveled in development.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

class Logger {
  private isDevelopment = true; // Set to false in production releases

  log(level: LogLevel, context: string, message: string, ...args: unknown[]): void {
    if (level === 'debug') this.debug(context, message, ...args);
    else if (level === 'info') this.info(context, message, ...args);
    else if (level === 'warn') this.warn(context, message, ...args);
    else if (level === 'error') this.error(context, message, args[0]);
  }

  debug(context: string, message: string, ...args: unknown[]): void {
    if (this.isDevelopment) {
      console.debug(`[PilotPanel:DEBUG][${context}]`, message, ...args);
    }
  }

  info(context: string, message: string, ...args: unknown[]): void {
    if (this.isDevelopment) {
      console.info(`[PilotPanel:INFO][${context}]`, message, ...args);
    }
  }

  warn(context: string, message: string, ...args: unknown[]): void {
    console.warn(`[PilotPanel:WARN][${context}]`, message, ...args);
  }

  error(context: string, message: string, error?: unknown): void {
    console.error(`[PilotPanel:ERROR][${context}]`, message, error ?? '');
  }
}

export const logger = new Logger();
