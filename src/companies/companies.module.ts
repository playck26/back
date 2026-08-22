import { Module } from '@nestjs/common';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';
import { PublicCompaniesController } from './public-companies.controller';

@Module({
  controllers: [CompaniesController, PublicCompaniesController],
  providers: [CompaniesService],
})
export class CompaniesModule {}
