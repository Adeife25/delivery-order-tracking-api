import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';

export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v1');
  app.use(helmet());

  const config = app.get(ConfigService);
  if (config.get<boolean>('TRUST_PROXY', false)) {
    const instance = app.getHttpAdapter().getInstance() as {
      set?: (setting: string, value: unknown) => void;
    };
    instance.set?.('trust proxy', 1);
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}
