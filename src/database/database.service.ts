import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose, { type ClientSession } from 'mongoose';

const TRANSIENT_LABELS = new Set([
  'TransientTransactionError',
  'UnknownTransactionCommitResult',
]);

export function isTransientTransactionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const labels = (error as { errorLabels?: unknown }).errorLabels;
  if (Array.isArray(labels)) {
    return labels.some((label) => TRANSIENT_LABELS.has(String(label)));
  }

  return (error as { code?: number }).code === 112;
}

export function isDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  if ((error as { code?: number }).code === 11000) {
    return true;
  }

  const writeErrors = (error as { writeErrors?: unknown }).writeErrors;
  return (
    Array.isArray(writeErrors) &&
    writeErrors.some(
      (writeError) =>
        typeof writeError === 'object' &&
        writeError !== null &&
        (writeError as { code?: number }).code === 11000,
    )
  );
}

export function sessionOptions(session?: ClientSession | null): {
  session?: ClientSession;
} {
  return session ? { session } : {};
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly url: string;

  constructor(config: ConfigService) {
    this.url = config.getOrThrow<string>('DATABASE_URL');
  }

  async onModuleInit(): Promise<void> {
    await mongoose.connect(this.url, {
      maxPoolSize: 20,
      serverSelectionTimeoutMS: 5000,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await mongoose.disconnect();
  }

  async ping(): Promise<void> {
    if (!mongoose.connection.db) {
      throw new Error('MongoDB connection is not established');
    }

    await mongoose.connection.db.admin().ping();
  }

  async withTransaction<T>(
    operation: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const session = await mongoose.startSession();

      try {
        let result!: T;
        await session.withTransaction(async () => {
          result = await operation(session);
        });
        return result;
      } catch (error) {
        lastError = error;
        if (!isTransientTransactionError(error) || attempt === 2) {
          throw error;
        }
      } finally {
        await session.endSession();
      }
    }

    throw lastError;
  }
}
