import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

const CONNECT_WAIT_MS = 3000;

@Injectable()
export class RedisService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  private readonly client?: Redis;
  private readonly publisher?: Redis;
  private readonly subscriber?: Redis;

  constructor(config: ConfigService) {
    const url = config.get<string>('REDIS_URL');

    if (!url) {
      this.logger.warn(
        'REDIS_URL is not set; running in single-instance mode without Redis',
      );
      return;
    }

    this.client = this.createClient(url, 'redis', false);
    this.publisher = this.createClient(url, 'redis-publisher', true);
    this.subscriber = this.createClient(url, 'redis-subscriber', true);
  }

  async onModuleInit(): Promise<void> {
    await Promise.all([
      this.waitUntilReady(this.client, 'client'),
      this.waitUntilReady(this.publisher, 'publisher'),
      this.waitUntilReady(this.subscriber, 'subscriber'),
    ]);
  }

  isEnabled(): boolean {
    return Boolean(this.client);
  }

  getClient(): Redis | undefined {
    return this.client;
  }

  getPublisher(): Redis | undefined {
    return this.publisher;
  }

  getSubscriber(): Redis | undefined {
    return this.subscriber;
  }

  async ping(): Promise<boolean> {
    if (!this.client) {
      return false;
    }

    try {
      const response = await this.withTimeout(this.client.ping(), 2000);
      return response === 'PONG';
    } catch {
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(
      [this.client, this.publisher, this.subscriber].map(async (client) => {
        if (!client) {
          return;
        }

        try {
          await client.quit();
        } catch {
          client.disconnect();
        }
      }),
    );
  }

  private createClient(
    url: string,
    name: string,
    allowOfflineQueue: boolean,
  ): Redis {
    const client = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: allowOfflineQueue,
      connectTimeout: 5000,
    });

    client.on('error', (error: Error) => {
      this.logger.warn(`Redis ${name} error: ${error.message}`);
    });

    return client;
  }

  private waitUntilReady(
    client: Redis | undefined,
    name: string,
  ): Promise<void> {
    if (!client || client.status === 'ready') {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const finish = (message?: string): void => {
        clearTimeout(timer);
        client.off('ready', onReady);
        client.off('error', onError);

        if (message) {
          this.logger.warn(message);
        }

        resolve();
      };

      const onReady = (): void => finish();
      const onError = (error: Error): void =>
        finish(`Redis ${name} unavailable: ${error.message}`);

      const timer = setTimeout(
        () => finish(`Redis ${name} not ready after ${CONNECT_WAIT_MS}ms`),
        CONNECT_WAIT_MS,
      );

      client.once('ready', onReady);
      client.once('error', onError);
    });
  }

  private withTimeout<T>(
    operation: Promise<T>,
    milliseconds: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Redis operation timed out')),
        milliseconds,
      );

      operation.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}
