import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CourtsModule } from '../courts/courts.module';
import { PeopleModule } from '../people/people.module';
import { PreReservaService } from './pre-reserva.service';
import { MePreReservasController } from './me-pre-reservas.controller';

/**
 * SPEC-074 — a pré-reserva: o aviso de que um horário de quadra vagou.
 *
 * ## Módulo próprio, e não dentro de `CourtsModule`
 *
 * O mesmo raciocínio que deu módulo próprio à fila de espera (SPEC-064): a
 * pré-reserva **lê** a grade, mas não é a grade. Pendurá-la em `CourtsModule`
 * — que já concentra quadra, reserva, agenda e catálogo — faria o sexto
 * agendador (TASK-003) nascer no módulo mais movimentado do repositório.
 *
 * ## As duas dependências, e o porquê de cada uma
 *
 * - `CourtsModule`, pelo `HorarioFuncionamentoService`: o expediente do dia é
 *   a mesma resolução da grade (D5/4), e não uma segunda;
 * - `PeopleModule`, pelo `StudentsService`: "aluno operante" é a mesma regra
 *   de reservar (D2), com os mesmos códigos.
 */
@Module({
  imports: [PrismaModule, CourtsModule, PeopleModule],
  controllers: [MePreReservasController],
  providers: [PreReservaService],
})
export class PreReservaModule {}
