import { Module } from '@nestjs/common';
import { FrequenciaModule } from '../frequencia/frequencia.module';
import { StorageModule } from '../storage/storage.module';
import { DisponibilidadeProfessorService } from './disponibilidade-professor.service';
import { FotoDeProfessorService } from './foto-de-professor.service';
import { LevelsController } from './levels.controller';
import { LevelsService } from './levels.service';
import { StudentsController } from './students.controller';
import { MeCadastroController } from './me-cadastro.controller';
import { ImportacaoController } from './importacao/importacao.controller';
import { ImportacaoDeAlunosService } from './importacao/importacao-de-alunos.service';
import { StudentsService } from './students.service';
import { TeacherPhotoController } from './teacher-photo.controller';
import { MeProfessoresController } from './me-professores.controller';
import { ProfessoresParaAlunoService } from './professores-para-aluno.service';
import { TeachersController } from './teachers.controller';
import { TeachersService } from './teachers.service';

@Module({
  // StorageModule entra pela foto de professor (SPEC-018/TASK-004), pelo
  // mesmo caminho que a logo entrou em MOD-002 e a imagem de quadra em
  // MOD-004.
  imports: [FrequenciaModule, StorageModule],
  controllers: [
    StudentsController,
    TeachersController,
    // SPEC-047 — a rota do ALUNO. Fica aqui e nao num modulo `me/` proprio
    // pelo mesmo motivo do `me-cadastro`: o servico e de pessoas, e um modulo
    // novo para uma rota criaria import circular ou uma segunda instancia.
    MeProfessoresController,
    TeacherPhotoController,
    LevelsController,
    // SPEC-036 — mora aqui, e nao num modulo `me/` proprio: o servico e o
    // mesmo (`StudentsService`), e um modulo novo so para dois metodos
    // criaria um import circular ou uma segunda instancia do servico.
    MeCadastroController,
    // SPEC-038 — importar alunos por planilha.
    ImportacaoController,
  ],
  providers: [
    ProfessoresParaAlunoService,
    StudentsService,
    ImportacaoDeAlunosService,
    TeachersService,
    LevelsService,
    FotoDeProfessorService,
    DisponibilidadeProfessorService,
  ],
  // SPEC-009/REQ-007: MOD-001 provisiona conta de aluno chamando o método
  // público de MOD-003, então o serviço precisa sair do módulo.
  // `DisponibilidadeProfessorService` sai do modulo porque a SPEC-039 (aula
  // avulsa) precisa perguntar se o professor atende — e o proprio motivo de
  // esta spec vir antes dela.
  exports: [
    StudentsService,
    FotoDeProfessorService,
    DisponibilidadeProfessorService,
  ],
})
export class PeopleModule {}
