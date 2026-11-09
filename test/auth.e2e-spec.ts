import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, resetDatabase } from './helpers/test-app';

describe('Auth endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const credentials = {
    fullName: 'Ada Obi',
    email: 'ada@example.com',
    password: 'strong-password-123',
  };

  let accessToken: string;
  let refreshToken: string;
  let userId: string;

  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    prisma = testApp.prisma;
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await app.close();
  });

  it('registers a customer and normalizes the email', async () => {
    const response = await api()
      .post('/api/v1/auth/register')
      .send({
        ...credentials,
        email: '  Ada@Example.com ',
      })
      .expect(201);

    expect(response.body.user).toMatchObject({
      fullName: credentials.fullName,
      email: credentials.email,
      role: 'CUSTOMER',
      isActive: true,
    });
    expect(response.body.user).not.toHaveProperty('passwordHash');
    userId = response.body.user.id;
  });

  it('rejects duplicate registration', async () => {
    await api().post('/api/v1/auth/register').send(credentials).expect(409);
  });

  it('rejects unauthenticated profile access', async () => {
    await api().get('/api/v1/users/me').expect(401);
  });

  it('rejects invalid credentials', async () => {
    await api()
      .post('/api/v1/auth/login')
      .send({ email: credentials.email, password: 'wrong-password' })
      .expect(401);
  });

  it('logs in and returns a token pair and public profile', async () => {
    const response = await api()
      .post('/api/v1/auth/login')
      .send({
        email: credentials.email,
        password: credentials.password,
      })
      .expect(200);

    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.refreshToken).toEqual(expect.any(String));
    expect(response.body.expiresIn).toBe(900);
    expect(response.body.user).toMatchObject({
      id: userId,
      email: credentials.email,
    });
    expect(response.body.user).not.toHaveProperty('passwordHash');

    accessToken = response.body.accessToken;
    refreshToken = response.body.refreshToken;
  });

  it('retrieves the authenticated profile', async () => {
    const response = await api()
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(response.body).toMatchObject({
      id: userId,
      email: credentials.email,
    });
    expect(response.body).not.toHaveProperty('passwordHash');
  });

  it('updates the authenticated profile', async () => {
    const response = await api()
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fullName: 'Ada N. Obi', phoneNumber: '+2348012345678' })
      .expect(200);

    expect(response.body).toMatchObject({
      fullName: 'Ada N. Obi',
      phoneNumber: '+2348012345678',
    });
  });

  it('rejects an invalid phone number', async () => {
    await api()
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ phoneNumber: 'not-a-phone' })
      .expect(400);
  });

  it('rotates refresh tokens and rejects the old token', async () => {
    const response = await api()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(200);

    expect(response.body.refreshToken).not.toBe(refreshToken);

    await api().post('/api/v1/auth/refresh').send({ refreshToken }).expect(401);

    accessToken = response.body.accessToken;
    refreshToken = response.body.refreshToken;
  });

  it('logs out and rejects the revoked refresh token', async () => {
    await api()
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ refreshToken })
      .expect(204);

    await api().post('/api/v1/auth/refresh').send({ refreshToken }).expect(401);
  });
});
