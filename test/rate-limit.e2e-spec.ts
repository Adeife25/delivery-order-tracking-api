import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import request from 'supertest';
import { createTestApp } from './helpers/test-app';

describe('Rate limiting (e2e)', () => {
  let app: INestApplication<App>;
  const originalLimit = process.env.AUTH_THROTTLE_LIMIT;

  beforeAll(async () => {
    process.env.AUTH_THROTTLE_LIMIT = '2';
    const testApp = await createTestApp();
    app = testApp.app;
  });

  it('throttles repeated authentication attempts', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'missing@example.com', password: 'wrong-password' })
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'missing@example.com', password: 'wrong-password' })
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'missing@example.com', password: 'wrong-password' })
      .expect(429);
  });

  afterAll(async () => {
    await app.close();
    if (originalLimit === undefined) {
      delete process.env.AUTH_THROTTLE_LIMIT;
    } else {
      process.env.AUTH_THROTTLE_LIMIT = originalLimit;
    }
  });
});
