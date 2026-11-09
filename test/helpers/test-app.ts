import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import request from 'supertest';
import { configureApp } from '../../src/app.setup';
import { AppModule } from '../../src/app.module';
import { EmailSender } from '../../src/notifications/email.sender';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RedisIoAdapter } from '../../src/redis/redis-io.adapter';
import { RedisService } from '../../src/redis/redis.service';

export interface TestApp {
  app: INestApplication<App>;
  prisma: PrismaService;
}

export interface CreateTestAppOptions {
  emailSender?: EmailSender;
}

export async function createTestApp(
  options: CreateTestAppOptions = {},
): Promise<TestApp> {
  let builder = Test.createTestingModule({
    imports: [AppModule],
  });

  if (options.emailSender) {
    builder = builder
      .overrideProvider(EmailSender)
      .useValue(options.emailSender);
  }

  const moduleFixture: TestingModule = await builder.compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>({
    rawBody: true,
  });

  const redisIoAdapter = new RedisIoAdapter(app, app.get(RedisService));
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  configureApp(app);
  await app.init();

  const redis = app.get(RedisService).getClient();
  if (redis) {
    const keys = await redis.keys('rl:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }

  return {
    app,
    prisma: app.get(PrismaService),
  };
}

export async function resetDatabase(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "RefreshToken", "DeliveryStatusHistory", "DeliveryAssignment", "DeliveryLocation", "Payment", "Notification", "Delivery", "Order", "User" CASCADE',
  );
}

export async function registerCustomer(
  app: INestApplication<App>,
  input: { fullName: string; email: string; password: string },
): Promise<{
  accessToken: string;
  refreshToken: string;
  user: { id: string };
}> {
  await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send(input)
    .expect(201);

  const loginResponse = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: input.email, password: input.password })
    .expect(200);

  return loginResponse.body as {
    accessToken: string;
    refreshToken: string;
    user: { id: string };
  };
}
