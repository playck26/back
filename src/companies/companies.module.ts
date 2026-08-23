import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';
import { MeCompanyController } from './me-company.controller';
import { PublicCompaniesController } from './public-companies.controller';

@Module({
  // SPEC-016/INV-031: MOD-002 delega a escrita de senha e sessão a
  // MOD-001, dono de `usuarios` e `refresh_tokens`.
  imports: [AuthModule],
  controllers: [
    CompaniesController,
    PublicCompaniesController,
    MeCompanyController,
  ],
  providers: [CompaniesService],
})
export class CompaniesModule {}
