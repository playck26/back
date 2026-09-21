/**
 * **DEF-036 — o saldo devolvia um crédito que não podia ser gasto.**
 *
 * ## O que acontecia
 *
 * A SPEC-046/D7 promete: *"reposição em aula cancelada não conta, e o crédito
 * volta sozinho"*. E ele voltava — **na tela**. `meuCredito` não soma a
 * reposição cujo destino o clube cancelou, então o número subia de volta.
 *
 * Mas a linha de `reposicoes_de_aula` continuava lá (só `desmarcar` apagava), e
 * a INV-118 é `UNIQUE (falta_id)`. Ao tentar usar o crédito, `marcar` via a
 * reposição e recusava com **`FALTA_JA_REPOSTA`**.
 *
 * > **O sistema mostrava um crédito e recusava gastá-lo.** A pessoa via "1
 * > crédito", escolhia outra aula, e levava um erro que diz que ela já repôs —
 * > quando o clube é que tinha cancelado.
 *
 * ## Como apareceu
 *
 * Não por reclamação nem por teste: pela **SPEC-064**. A fila de espera precisa
 * saber se alguém tem crédito (LIM-064e), e ao trazer a regra dos dois lugares
 * onde ela morava para um arquivo só, as duas versões ficaram lado a lado — e
 * **discordavam num caso**. Ver `credito-de-reposicao.ts`.
 *
 * ## A correção, e por que esta e não a outra
 *
 * Havia duas saídas:
 *
 * | | efeito |
 * |---|---|
 * | **o saldo para de devolver o crédito** | honesto, mas **pune a pessoa pelo gesto do clube** — ela perde a reposição porque o clube cancelou |
 * | **cancelar a aula apaga as reposições dela** | o crédito volta **de verdade**, e a D7 passa a valer nos dois lados |
 *
 * A segunda. A D7 já era a decisão de produto; o defeito é que o caminho de
 * escrita não a honrava. E apagar não destrói história: a aula **não
 * aconteceu**, e `desmarcar` já apagava a mesma linha por gesto do aluno.
 *
 * Este arquivo **nasceu vermelho** e é a prova de que nasceu.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { ReposicaoService } from '../../src/classes/reposicao.service';
import { ClassesService } from '../../src/classes/classes.service';
import { CourtsService } from '../../src/courts/courts.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import { StudentsService } from '../../src/people/students.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import type { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = 'd0360000-0000-4000-8000-000000000001';
const QUADRA = 'd0360000-0000-4000-8000-000000000002';
const TURMA_ORIGEM = 'd0360000-0000-4000-8000-00000000000a';
const TURMA_ALVO = 'd0360000-0000-4000-8000-00000000000b';
const ADMIN = 'd0360000-0000-4000-8000-00000000000c';

const db = new PrismaClient();
const p = db as unknown as PrismaService;
const q = (sql: string) => db.$executeRawUnsafe(sql);

const operacao = () => new ConfigOperacaoService(p);
const reposicoes = () => new ReposicaoService(p, operacao());

function classes(): ClassesService {
  const courts = new CourtsService(
    p,
    { exigirAlunoOperante: () => undefined } as unknown as StudentsService,
    new HorarioFuncionamentoService(p),
    {} as unknown as ImagemDaQuadraService,
    operacao(),
    new CreditosService(),
    { carregarSemana: jest.fn() } as unknown as DisponibilidadeProfessorService,
  );
  return new ClassesService(p, courts, new StudentsService(p), operacao());
}

function emDias(dias: number): string {
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

let ocSeq = 0;
async function ocorrencia(turmaId: string, data: string, hora: string) {
  ocSeq += 1;
  const id = `d0360000-0000-4000-8000-300000000${String(ocSeq).padStart(3, '0')}`;
  const fim = `${String(Number(hora.slice(0, 2)) + 1).padStart(2, '0')}:00`;
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${id}','${EMPRESA}','${QUADRA}','${data}','${hora}','${fim}','TURMA','${turmaId}','pendente_pagamento',now())`,
  );
  return id;
}

const USUARIO = 'd0360000-0000-4000-8000-100000000001';
const ALUNO = 'd0360000-0000-4000-8000-200000000001';
const FALTA = 'd0360000-0000-4000-8000-400000000001';

async function montar(): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','DEF-036','def-036-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  const esporte = await db.esporteDeQuadra.findFirstOrThrow({
    where: { companyId: EMPRESA },
    select: { id: true },
  });
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA}','${EMPRESA}','Q','${esporte.id}',80,'ativa')`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${ADMIN}','admin.def036@x.com','h','Gestor','company_admin','${EMPRESA}',now())`,
  );
  for (const t of [TURMA_ORIGEM, TURMA_ALVO]) {
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${t}','${EMPRESA}','T','${QUADRA}',10,'ativa')`,
    );
  }
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${USUARIO}','aluno.def036@x.com','h','Faltou','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${ALUNO}','${USUARIO}','${EMPRESA}','aprovado','ativo')`,
  );
  await q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${TURMA_ORIGEM}','${ALUNO}',now())`,
  );
  const perdida = await ocorrencia(TURMA_ORIGEM, emDias(-3), '07:00');
  await q(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES ('${FALTA}','${EMPRESA}','${perdida}','${ALUNO}',now())`,
  );
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  ocSeq = 0;
  await montar();
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('DEF-036 — o crédito que o saldo mostrava e o marcar recusava', () => {
  /**
   * **O caso inteiro, ponta a ponta.** É o que a pessoa faz, na ordem em que
   * ela faz.
   */
  it('o clube cancela a aula de destino: o crédito volta E pode ser gasto', async () => {
    // 1. ele repõe numa aula.
    const primeira = await ocorrencia(TURMA_ALVO, emDias(4), '09:00');
    await reposicoes().marcar(EMPRESA, USUARIO, FALTA, primeira);
    expect((await reposicoes().meuCredito(EMPRESA, USUARIO)).creditos).toBe(0);

    // 2. o CLUBE cancela aquela aula.
    await classes().cancelarOcorrencia(
      EMPRESA,
      TURMA_ALVO,
      primeira,
      'aula cancelada pelo clube',
      ADMIN,
    );

    // 3. a SPEC-046/D7 promete que o crédito volta — e ele volta na tela.
    expect((await reposicoes().meuCredito(EMPRESA, USUARIO)).creditos).toBe(1);

    // 4. **E TEM DE PODER SER GASTO.** Antes do DEF-036 esta linha levava
    //    `FALTA_JA_REPOSTA`: a linha de `reposicoes_de_aula` da aula
    //    cancelada continuava lá, e a INV-118 é `UNIQUE (falta_id)`.
    const segunda = await ocorrencia(TURMA_ALVO, emDias(5), '10:00');
    await expect(
      reposicoes().marcar(EMPRESA, USUARIO, FALTA, segunda),
    ).resolves.toMatchObject({ faltaId: FALTA, ocupacaoId: segunda });

    // 5. e agora existe UMA reposição: a que vale.
    const vivas = await db.reposicaoDeAula.findMany({
      where: { companyId: EMPRESA, faltaId: FALTA },
      select: { ocupacaoId: true },
    });
    expect(vivas).toHaveLength(1);
    expect(vivas[0].ocupacaoId).toBe(segunda);
  });

  it('cancelar a aula apaga SÓ as reposições dela', async () => {
    // Um segundo aluno, com reposição numa aula que NÃO será cancelada.
    const usuario2 = 'd0360000-0000-4000-8000-100000000002';
    const aluno2 = 'd0360000-0000-4000-8000-200000000002';
    const falta2 = 'd0360000-0000-4000-8000-400000000002';
    await q(
      `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuario2}','aluno2.def036@x.com','h','Outro','aluno','${EMPRESA}',now())`,
    );
    await q(
      `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${aluno2}','${usuario2}','${EMPRESA}','aprovado','ativo')`,
    );
    await q(
      `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${TURMA_ORIGEM}','${aluno2}',now())`,
    );
    const perdida2 = await ocorrencia(TURMA_ORIGEM, emDias(-3), '08:00');
    await q(
      `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES ('${falta2}','${EMPRESA}','${perdida2}','${aluno2}',now())`,
    );

    const cancelada = await ocorrencia(TURMA_ALVO, emDias(4), '09:00');
    const preservada = await ocorrencia(TURMA_ALVO, emDias(6), '11:00');
    await reposicoes().marcar(EMPRESA, USUARIO, FALTA, cancelada);
    await reposicoes().marcar(EMPRESA, usuario2, falta2, preservada);

    await classes().cancelarOcorrencia(
      EMPRESA,
      TURMA_ALVO,
      cancelada,
      'aula cancelada pelo clube',
      ADMIN,
    );

    // A da aula cancelada sumiu; a outra continua.
    expect(
      await db.reposicaoDeAula.count({
        where: { companyId: EMPRESA, ocupacaoId: cancelada },
      }),
    ).toBe(0);
    expect(
      await db.reposicaoDeAula.count({
        where: { companyId: EMPRESA, ocupacaoId: preservada },
      }),
    ).toBe(1);
  });
});
