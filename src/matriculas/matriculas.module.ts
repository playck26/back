import { Module } from '@nestjs/common';
import { PeopleModule } from '../people/people.module';
import { PrismaModule } from '../prisma/prisma.module';
import { MatriculasController } from './matriculas.controller';
import { MatriculasService } from './matriculas.service';
import { MeMatriculaController } from './me-matricula.controller';
import { VencimentosController } from './vencimentos.controller';
import { PlanosController } from './planos.controller';
import { PlanosService } from './planos.service';

/**
 * SPEC-037 — MOD-012: planos e matriculas.
 *
 * **Modulo proprio, e nao dentro de `people`.** A matricula e comercial; o
 * `people` e cadastral. Junta-las faria o modulo que ja e o maior do lado de
 * pessoas crescer para um assunto que so compartilha o `aluno_id`.
 *
 * `MatriculasService` e exportado porque o `InvitesService` o chama DENTRO da
 * transacao do aceite (AC-015) -- a matricula nasce junto da conta e do
 * aceite, ou nenhuma das tres nasce.
 */
@Module({
  // DEF-027 — `PeopleModule` entra por causa de `StudentsService
  // .garantirAlunoOperante`: a trava de vinculo+status vive em MOD-003, dono
  // da tabela `alunos`, e este modulo a CHAMA em vez de reescrever a
  // comparacao. Sem ciclo: `PeopleModule` importa `Frequencia` e `Storage`, e
  // nenhum dos dois chega aqui.
  imports: [PrismaModule, PeopleModule],
  // SPEC-045 — `VencimentosController` vem ANTES de `MatriculasController` na
  // lista? Nao importa: o Nest casa por caminho, e `matriculas/vencimentos`
  // nao colide com `students/:alunoId/matriculas`. A ordem aqui e so leitura.
  controllers: [
    PlanosController,
    MatriculasController,
    MeMatriculaController,
    VencimentosController,
  ],
  providers: [PlanosService, MatriculasService],
  exports: [MatriculasService],
})
export class MatriculasModule {}
