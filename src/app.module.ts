import { ExecutionContext, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminusModule } from '@nestjs/terminus';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { CentersModule } from './centers/centers.module';
import { DatabaseExceptionFilter } from './common/database-exception.filter';
import { AppThrottlerGuard, JwtAuthGuard, RolesGuard } from './common/guards';
import { validateEnv } from './config/env.validation';
import { DashboardModule } from './dashboard/dashboard.module';
import { typeormOptions } from './database/data-source';
import { HealthController } from './health/health.controller';
import { PublicModule } from './public/public.module';
import { ProposalsModule } from './proposals/proposals.module';
import { ScopeModule } from './scope/scope.module';
import { SimulationModule } from './simulation/simulation.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level:
            { production: 'info', test: 'silent' }[config.get<string>('NODE_ENV', 'development')] ?? 'debug',
          transport:
            config.get('NODE_ENV') === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
          redact: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.body.password',
            'req.body.idToken',
          ],
          autoLogging: { ignore: (req) => req.url === '/api/v1/health' },
        },
      }),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        ...typeormOptions(config.getOrThrow<string>('DATABASE_URL')),
        autoLoadEntities: false,
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const ttl = config.get<number>('THROTTLE_TTL_MS', 60000);
        const signedIn = (ctx: ExecutionContext) => !!ctx.switchToHttp().getRequest().user;
        return [
          // anyone not signed in (public finder, sign-in): per client IP
          { name: 'default', ttl, limit: config.get<number>('THROTTLE_LIMIT', 60), skipIf: signedIn },
          // signed-in office users: per account, a much bigger budget
          { name: 'office', ttl, limit: config.get<number>('THROTTLE_OFFICE_LIMIT', 600), skipIf: (ctx: ExecutionContext) => !signedIn(ctx) },
        ];
      },
    }),
    ScheduleModule.forRoot(),
    TerminusModule,
    ScopeModule,
    AuthModule,
    SimulationModule,
    DashboardModule,
    CentersModule,
    ProposalsModule,
    PublicModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: the user must be known before the rate limit is applied.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: DatabaseExceptionFilter },
  ],
})
export class AppModule {}
