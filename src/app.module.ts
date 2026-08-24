import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { ClassesModule } from './classes/classes.module';
import { CompaniesModule } from './companies/companies.module';
import { CourtsModule } from './courts/courts.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { PaymentConfigModule } from './payment-config/payment-config.module';
import { PeopleModule } from './people/people.module';
import { PrismaModule } from './prisma/prisma.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
    PrismaModule,
    AuthModule,
    CommonModule,
    CompaniesModule,
    PeopleModule,
    CourtsModule,
    ClassesModule,
    DashboardModule,
    PaymentConfigModule,
    // SPEC-017 (MOD-008) — fundação de mídia. Registrado sem consumidor de
    // propósito: é o que faz a validação das seis variáveis do Spaces
    // rodar no boot. Nenhuma rota depende dele até a SPEC-018.
    StorageModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
