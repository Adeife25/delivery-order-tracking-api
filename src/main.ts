import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { configureApp } from './app.setup';
import { RedisIoAdapter } from './redis/redis-io.adapter';
import { RedisService } from './redis/redis.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  app.useLogger(app.get(Logger));

  const redisIoAdapter = new RedisIoAdapter(app, app.get(RedisService));
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  configureApp(app);
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('Delivery and Order Tracking API')
    .setDescription(
      'API documentation for the delivery and order tracking system.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

 const configService = app.get(ConfigService);
const port = Number(configService.get<string>('PORT') ?? 3000);

await app.listen(port, '0.0.0.0');
  app.flushLogs();
}
bootstrap();
