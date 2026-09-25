import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { CompaniesController } from './companies.controller';
import { CompanyLogoController } from './company-logo.controller';
import { LogoDaEmpresaService } from './logo-da-empresa.service';
import { CompaniesService } from './companies.service';
import { MeCompanyController } from './me-company.controller';
import { PublicCompaniesController } from './public-companies.controller';
import { CompanySettingsModule } from '../company-settings/company-settings.module';
import { PeopleModule } from '../people/people.module';

@Module({
  // SPEC-016/INV-031: MOD-002 delega a escrita de senha e sessão a
  // MOD-001, dono de `usuarios` e `refresh_tokens`.
  // `StorageModule` entra pela logo (SPEC-018/TASK-006): MOD-002 é dono de
  // `empresas`, e `empresas.logo_key` mora ali.
  // SPEC-075/D7 — `PeopleModule` entra pelos níveis padrão da empresa nova:
  // quem escreve `niveis` é MOD-003 (`LevelsService.semearNiveisPadrao`), e a
  // dependência MOD-002 -> MOD-003 é o DELTA-006 do TARGET_ARCHITECTURE.md.
  // Sem ciclo: `PeopleModule` não chega ao `CompaniesModule`.
  imports: [CompanySettingsModule, AuthModule, StorageModule, PeopleModule],
  controllers: [
    CompaniesController,
    PublicCompaniesController,
    MeCompanyController,
    CompanyLogoController,
  ],
  providers: [CompaniesService, LogoDaEmpresaService],
})
export class CompaniesModule {}
