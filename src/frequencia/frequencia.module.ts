import { Module } from '@nestjs/common';
import { FrequenciaService } from './frequencia.service';

/**
 * SPEC-015 — módulo próprio porque o serviço atende DOIS módulos:
 * `ClassesModule` (relatório da turma, TASK-001) e `PeopleModule`
 * (relatório do aluno, TASK-002).
 *
 * Não dava para deixá-lo em `ClassesModule` e importá-la de `PeopleModule`:
 * `ClassesModule` já importa `PeopleModule`, e isso fecharia um ciclo.
 * `forwardRef` resolveria e esconderia o problema — o serviço simplesmente
 * não pertence a nenhum dos dois, e depende só do Prisma.
 */
@Module({
  providers: [FrequenciaService],
  exports: [FrequenciaService],
})
export class FrequenciaModule {}
