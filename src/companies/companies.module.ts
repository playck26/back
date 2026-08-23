import { Module } from '@nestjs/common';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';
import { MeCompanyController } from './me-company.controller';
import { PublicCompaniesController } from './public-companies.controller';

@Module({
  controllers: [
    CompaniesController,
    PublicCompaniesController,
    MeCompanyController,
  ],
  providers: [CompaniesService],
})
export class CompaniesModule {}
