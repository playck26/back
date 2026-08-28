import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AceitesModule } from './aceites/aceites.module';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { ClassesModule } from './classes/classes.module';
import { CompaniesModule } from './companies/companies.module';
import { CourtsModule } from './courts/courts.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { PaymentConfigModule } from './payment-config/payment-config.module';
import { PeopleModule } from './people/people.module';
import { PrismaModule } from './prisma/prisma.module';
import { ThrottlerPorUsuario } from './storage/limite-de-upload';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
    // O `ThrottlerPorUsuario` confere o Bearer token ele mesmo, porque
    // `APP_GUARD` roda ANTES do `JwtAuthGuard` de rota — ver o cabeçalho
    // de `limite-de-upload.ts`. Registro próprio, sem segredo fixado: o
    // segredo vai explícito em cada `verifyAsync`.
    JwtModule.register({}),
    PrismaModule,
    AuthModule,
    CommonModule,
    AceitesModule,
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
      // SPEC-017/TASK-006 — conta por USUÁRIO quando há um, e só cai no IP
      // quando não há. IP é a chave errada para um clube: o wi-fi
      // compartilhado faria um gestor bater no teto do colega, e um abusador
      // com IP rotativo passaria batido.
      useClass: ThrottlerPorUsuario,
    },
  ],
})
export class AppModule {}
