import { ClassSerializerInterceptor, INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

/** Shared HTTP setup (also used by the e2e tests). */
export function configureApp(app: INestApplication) {
  const config = app.get(ConfigService);
  const proxies = config.get<number>('TRUST_PROXY', 0);
  if (proxies > 0) (app.getHttpAdapter().getInstance() as { set(k: string, v: unknown): void }).set('trust proxy', proxies);
  app.use(helmet());
  const origins = (config.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins.length ? origins : false, credentials: false });
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));
  app.enableShutdownHooks();
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app);

  const config = app.get(ConfigService);
  if (config.get('NODE_ENV') !== 'production') {
    const doc = new DocumentBuilder()
      .setTitle('Project AGA API')
      .setDescription(
        'AI-Based Assessment Center Gap Analysis (TESDA Team C). Office dashboards for CO / RO / PO, ' +
          'the utilization simulation with drag-and-drop what-if, and the public learner finder.',
      )
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc));
  }
  await app.listen(config.get<number>('PORT', 3000));
}

if (require.main === module) {
  void bootstrap();
}
