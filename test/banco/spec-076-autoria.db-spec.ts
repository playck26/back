/**
 * SPEC-076/TASK-003 — **o banco, e não o texto** (D10, AC-002, INV-076a).
 *
 * Ninguém grava presença à mão (decisões 1 e 9). A rota saiu (D1), mas a
 * garantia não pode depender de ninguém escrever outra: os gatilhos da D10
 * recusam, com `23514`, presença com autor humano e cabeçalho `completa` de
 * origem humana — por QUALQUER caminho. As provas rodam pelo **login runtime**
 * (`playck_runtime`), o mesmo da aplicação, e cada recusa é conferida pelo
 * código do banco E pelo efeito (nada gravado).
 *
 * O que NÃO se prova aqui, porque o banco não distingue (LIM-076a): um
 * escritor novo que grave presença SEM autor é, para o gatilho, igual ao
 * worker.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import {
  garantirConexoesDeTeste,
  garantirLoginsDeTeste,
  ligarPresencaAutomatica,
  redefinirConfigDePresenca,
} from './config-de-presenca';
import {
  EMPRESA,
  TURMA_A,
  UPROF,
  aluno,
  aula,
  cabecalhoDe,
  chamadaCrua,
  db,
  desconectarTodos,
  diasAtras,
  linhasDe,
  matricular,
  montarEmpresa,
  q,
  reiniciarSequencias,
  runtime,
} from './presenca-automatica-fixture';
import { PresencaService } from '../../src/classes/presenca.service';
import { FechamentoAutomaticoService } from '../../src/presenca-automatica/fechamento-automatico.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(240_000);
exigirBancoLocal();

const app = runtime as unknown as PrismaService;

/** O SQLSTATE da recusa, ou `ok`. */
async function sqlstate(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const texto = String((e as Error).message ?? e);
    const codigo = /\b(23514|23503|23001|42501)\b/.exec(texto);
    return codigo ? codigo[1] : texto.slice(0, 120);
  }
}

beforeAll(async () => {
  await garantirLoginsDeTeste(db);
  await garantirConexoesDeTeste(db);
});

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await redefinirConfigDePresenca(db);
  reiniciarSequencias();
  await montarEmpresa();
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await redefinirConfigDePresenca(db);
  await desconectarTodos();
});

/** Uma aula de ontem com um aluno e um cabeçalho AUTOMÁTICO sem linhas. */
async function aulaComCabecalhoAutomatico() {
  const a = await aluno('Ana');
  await matricular(TURMA_A, a.alunoId);
  const oc = await aula(TURMA_A, -1);
  await q(
    `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,registrada_por,updated_at,completude,esperados,origem,origem_inicial,fechada_automaticamente_em)
     VALUES ('${oc}','TURMA','${EMPRESA}',NULL,now(),'completa',1,'automatica','automatica',clock_timestamp())`,
  );
  return { a, oc };
}

const insertPresencaComAutor = (oc: string, alunoId: string) =>
  `INSERT INTO presencas (id,company_id,ocupacao_id,origem_tipo,aluno_id,status,registrado_por,updated_at)
   VALUES (gen_random_uuid(),'${EMPRESA}','${oc}','TURMA','${alunoId}','presente','${UPROF}',now())`;

describe('AC-002 — os gatilhos da D10, pelo login runtime', () => {
  it('(i) INSERT de presença com autor → 23514, e nada gravado', async () => {
    const { a, oc } = await aulaComCabecalhoAutomatico();
    expect(
      await sqlstate(
        runtime.$executeRawUnsafe(insertPresencaComAutor(oc, a.alunoId)),
      ),
    ).toBe('23514');
    expect(await linhasDe(oc)).toHaveLength(0);
  });

  it('(ii) UPDATE de uma linha legada com autor → 23514, e a linha fica como estava', async () => {
    const a = await aluno('Ana');
    await matricular(TURMA_A, a.alunoId);
    const oc = await aula(TURMA_A, -1);
    await chamadaCrua(oc, 'professor', [[a.alunoId, 'presente']]);

    expect(
      await sqlstate(
        runtime.$executeRawUnsafe(
          `UPDATE presencas SET status = 'ausente' WHERE ocupacao_id = '${oc}'`,
        ),
      ),
    ).toBe('23514');
    expect((await linhasDe(oc))[0]).toMatchObject({
      status: 'presente',
      autor: UPROF,
    });
  });

  it('(iii) INSERT de cabeçalho `completa` com origem humana → 23514', async () => {
    const oc = await aula(TURMA_A, -1);
    expect(
      await sqlstate(
        runtime.$executeRawUnsafe(
          `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,registrada_por,updated_at,completude,esperados,origem,origem_inicial)
           VALUES ('${oc}','TURMA','${EMPRESA}','${UPROF}',now(),'completa',1,'professor','professor')`,
        ),
      ),
    ).toBe('23514');
    expect(await cabecalhoDe(oc)).toBeNull();
  });

  it('(iv) por DELEGATE recebido como parâmetro, e por SQL montado de duas constantes → 23514', async () => {
    const { a, oc } = await aulaComCabecalhoAutomatico();

    // Um escritor que nenhuma varredura textual acharia: o delegate chega
    // por parâmetro, sem `presenca.create` escrito em lugar nenhum.
    type Delegate = {
      create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
    };
    const gravar = (d: Delegate) =>
      d.create({
        data: {
          companyId: EMPRESA,
          ocupacaoId: oc,
          origemTipo: 'TURMA',
          alunoId: a.alunoId,
          status: 'presente',
          registradoPor: UPROF,
        },
      });
    expect(
      await sqlstate(gravar(runtime.presenca as unknown as Delegate)),
    ).toBe('23514');

    const INICIO = 'INSERT INTO presen';
    const RESTO = `cas (id,company_id,ocupacao_id,origem_tipo,aluno_id,status,registrado_por,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','${oc}','TURMA','${a.alunoId}','presente','${UPROF}',now())`;
    expect(await sqlstate(runtime.$executeRawUnsafe(INICIO + RESTO))).toBe(
      '23514',
    );
    expect(await linhasDe(oc)).toHaveLength(0);
  });

  it('(v) o worker e o refechamento do "Desfazer" passam — autor nulo', async () => {
    const a = await aluno('Ana');
    await matricular(TURMA_A, a.alunoId);
    const oc = await aula(TURMA_A, -1);
    await ligarPresencaAutomatica(db, diasAtras(3));

    await new FechamentoAutomaticoService(app).executarTick();
    expect(await cabecalhoDe(oc)).toMatchObject({ origem: 'automatica' });

    const presenca = new PresencaService(app);
    await presenca.registrarNaoHouve(EMPRESA, oc, UPROF, true);
    await presenca.desfazerNaoHouve(EMPRESA, oc, UPROF, true);
    expect(await cabecalhoDe(oc)).toMatchObject({
      origem: 'automatica',
      completude: 'completa',
    });
    expect(await linhasDe(oc)).toHaveLength(1);
  });

  it('(vi) o `openapi.json` não tem PUT, POST nem PATCH sob `/me/teacher/attendance/` fora de `…/nao-houve`', () => {
    const openapi = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'openapi.json'), 'utf8'),
    ) as { paths: Record<string, Record<string, unknown>> };
    const mutadores = Object.entries(openapi.paths)
      .filter(
        ([rota]) =>
          rota.startsWith('/api/v1/me/teacher/attendance/') &&
          !rota.endsWith('/nao-houve'),
      )
      .flatMap(([rota, ops]) =>
        Object.keys(ops)
          .filter((m) => ['put', 'post', 'patch'].includes(m))
          .map((m) => `${m} ${rota}`),
      );
    expect(mutadores).toEqual([]);
    // E a rota que ficou continua lá (a leitura) — senão o filtro acima
    // passaria com o contrato vazio.
    expect(
      openapi.paths['/api/v1/me/teacher/attendance/{ocupacaoId}']?.get,
    ).toBeDefined();
  });
});
