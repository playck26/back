import { Module } from '@nestjs/common';
import { AceitesService } from './aceites.service';
import { ContratoDaEmpresaController } from './contrato-da-empresa.controller';
import { MeAceitesController } from './me-aceites.controller';

@Module({
  controllers: [MeAceitesController, ContratoDaEmpresaController],
  providers: [AceitesService],
  exports: [AceitesService],
})
export class AceitesModule {}
