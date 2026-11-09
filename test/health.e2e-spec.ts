import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import request from 'supertest';
import { createTestApp } from './helpers/test-app';

describe('Health endpoint (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
  });

  it('returns the API process health status', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('reports readiness with database connectivity', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(200);

    expect(response.body).toMatchObject({ status: 'ok', database: 'up' });
    expect(['up', 'disabled']).toContain(response.body.redis);
  });

  it('propagates a request id header', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('x-request-id', 'test-request-id')
      .expect(200);

    expect(response.headers['x-request-id']).toBe('test-request-id');
  });

  it('generates a request id when one is not provided', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200);

    expect(response.headers['x-request-id']).toEqual(expect.any(String));
  });

  afterAll(async () => {
    await app.close();
  });
});
