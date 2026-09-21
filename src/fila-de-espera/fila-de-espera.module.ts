import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CompanySettingsModule } from '../company-settings/company-settings.module';
import { FilaDeEsperaService } from './fila-de-espera.service';
import { MeFilaDeEsperaController } from './me-fila-de-espera.controller';
import { VarredorDaFilaService } from './varredor-da-fila.service';
import { AgendadorDaFila } from './agendador-da-fila.service';

/**
 * SPEC-064 — a lista de espera (card 5331).
 *
 * ## Módulo próprio, e não dentro de `ClassesModule`
 *
 * A fila **atravessa** turma e ocorrência: a de turma é vaga de matrícula, a de
 * aula é vaga de reposição. Pendurá-la em `ClassesModule` — que já concentra
 * matrícula, reposição, presença, chamada e agenda — faria o quinto agendador
 * (TASK-003) nascer no arquivo mais movimentado do repositório.
 *
 * É o mesmo raciocínio que deu controller próprio à reposição (SPEC-046) e
 * módulo próprio ao push (SPEC-062).
 *
 * ## Depende de `CompanySettingsModule`, e só por causa do crédito
 *
 * `ConfigOperacaoService` responde a validade do crédito de reposição
 * (`validadeDias`), que é configuração da empresa. Sem ela a LIM-064e não tem
 * como ser decidida.
 */
@Module({
  imports: [PrismaModule, CompanySettingsModule],
  controllers: [MeFilaDeEsperaController],
  providers: [FilaDeEsperaService, VarredorDaFilaService, AgendadorDaFila],
  exports: [FilaDeEsperaService, VarredorDaFilaService],
})
export class FilaDeEsperaModule {}
