/**
 * SPEC-033/TASK-003 — **o serviço do saldo contra Postgres de verdade.**
 *
 * ## Por que db-spec e não unitário
 *
 * Quase tudo que este serviço garante mora no banco: o saldo é escrito por
 * **trigger** (D1/INV-071), o motivo obrigatório é `CHECK` (AC-003), a
 * causalidade da devolução é **FK de seis colunas** (D5), e o `FOR UPDATE` do
 * AC-004 só existe se houver uma linha de verdade para travar. Um unitário com
 * `tx` mockado provaria que o TypeScript compila — nenhuma dessas.
 *
 * As provas de concorrência (FIT-025, FIT-028) são da TASK-009 e exigem duas
 * conexões com barreira. Aqui o escopo é o **comportamento sequencial dos
 * quatro tipos**, que é o que a TASK-003 entrega.
 */
import { PrismaClient } from '@prisma/client';
import { UnprocessableEntityException } from '@nestjs/common';
import { CreditosService } from '../../src/creditos/creditos.service';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const db = new PrismaClient();
const creditos = new CreditosService();

const EMPRESA = 'c0330000-0000-4000-8000-000000000001';
const UADMIN = 'c0330000-0000-4000-8000-000000000002';
const UALUNO = 'c0330000-0000-4000-8000-000000000003';
const ALUNO = 'c0330000-0000-4000-8000-000000000004';
const ESPORTE = 'c0330000-0000-4000-8000-000000000005';
const QUADRA = 'c0330000-0000-4000-8000-000000000006';
const OCUPACAO = 'c0330000-0000-4000-8000-000000000007';

const q = (sql: string) => db.$executeRawUnsafe(sql);

/** A ação administrativa que todo movimento exige (SPEC-032). */
async function novaAcao(
  tipo: 'credito_lancado' | 'credito_retirado' | 'reserva_criada',
) {
  const linhas = await db.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO acoes_administrativas (id, company_id, tipo, autor_id)
     VALUES (gen_random_uuid(), '${EMPRESA}', '${tipo}', '${UADMIN}')
     RETURNING id`,
  );
  return linhas[0].id;
}

const saldo = async () => {
  const linhas = await db.$queryRawUnsafe<{ saldo_creditos: number }[]>(
    `SELECT saldo_creditos FROM alunos WHERE id = '${ALUNO}'`,
  );
  return linhas[0].saldo_creditos;
};

/** O `code` do corpo do erro — é ele que o frontend lê, não a mensagem. */
function codeDoErro(erro: unknown): string | undefined {
  const resposta = (erro as UnprocessableEntityException).getResponse?.();
  return (resposta as { code?: string })?.code;
}

beforeAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await q(`INSERT INTO empresas (id,nome,updated_at,slug)
           VALUES ('${EMPRESA}','Creditos TASK-003',now(),'creditos-task-003')`);
  await q(`INSERT INTO usuarios (id,email,senha_hash,nome,role,updated_at,company_id)
           VALUES ('${UADMIN}','admin@c033.test','x','Admin','company_admin',now(),'${EMPRESA}')`);
  await q(`INSERT INTO usuarios (id,email,senha_hash,nome,role,updated_at,company_id)
           VALUES ('${UALUNO}','aluno@c033.test','x','Aluno','aluno',now(),'${EMPRESA}')`);
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id) VALUES ('${ALUNO}','${UALUNO}','${EMPRESA}')`,
  );
  await q(`INSERT INTO esportes_de_quadra (id,company_id,nome,ordem)
           VALUES ('${ESPORTE}','${EMPRESA}','Tenis',1)`);
  await q(`INSERT INTO quadras (id,company_id,nome,preco_hora,esporte_id)
           VALUES ('${QUADRA}','${EMPRESA}','Q1',80,'${ESPORTE}')`);
  await q(`INSERT INTO ocupacoes_quadra
             (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,updated_at,aluno_id,valor)
           VALUES ('${OCUPACAO}','${EMPRESA}','${QUADRA}','2031-03-01','10:00','11:00','AVULSO',now(),'${ALUNO}',80)`);
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('CreditosService — os quatro tipos, contra Postgres real', () => {
  it('o aluno NASCE com saldo zero, e não por escolha do serviço', async () => {
    // A guarda de `INSERT` da INV-071 recusa qualquer outro valor — foi o
    // DEF-VC033-01, e `BEFORE UPDATE OF` sozinho não pegava isto.
    expect(await saldo()).toBe(0);
  });

  it('`lancar` credita, e quem escreve o saldo é a TRIGGER', async () => {
    const acaoId = await novaAcao('credito_lancado');
    await db.$transaction(async (tx) => {
      await creditos.lancar(tx, {
        companyId: EMPRESA,
        alunoId: ALUNO,
        valorCentavos: 20_000,
        motivo: 'aporte inicial',
        autorId: UADMIN,
        acaoId,
      });
    });
    expect(await saldo()).toBe(20_000);
  });

  it('`retirar` debita', async () => {
    const acaoId = await novaAcao('credito_retirado');
    await db.$transaction(async (tx) => {
      await creditos.retirar(tx, {
        companyId: EMPRESA,
        alunoId: ALUNO,
        valorCentavos: 5_000,
        motivo: 'estorno de aporte',
        autorId: UADMIN,
        acaoId,
      });
    });
    expect(await saldo()).toBe(15_000);
  });

  it('retirada acima do saldo é 422 SALDO_INSUFICIENTE, e NÃO grava (AC-004)', async () => {
    const acaoId = await novaAcao('credito_retirado');
    const antes = await saldo();
    let capturado: unknown;
    try {
      await db.$transaction(async (tx) => {
        await creditos.retirar(tx, {
          companyId: EMPRESA,
          alunoId: ALUNO,
          valorCentavos: antes + 1,
          motivo: 'tentativa acima do saldo',
          autorId: UADMIN,
          acaoId,
        });
      });
    } catch (erro) {
      capturado = erro;
    }
    expect(capturado).toBeInstanceOf(UnprocessableEntityException);
    expect(codeDoErro(capturado)).toBe('SALDO_INSUFICIENTE');
    expect(await saldo()).toBe(antes);
  });

  it('motivo em branco é recusado PELO BANCO, e o serviço traduz (AC-003)', async () => {
    // A garantia é o `CHECK movimentos_motivo_administrativo`; o serviço só
    // troca `500` por `422`. Por isso o teste manda espaço em branco, que
    // passaria por qualquer validação de "campo obrigatório" no DTO.
    const acaoId = await novaAcao('credito_lancado');
    const antes = await saldo();
    let capturado: unknown;
    try {
      await db.$transaction(async (tx) => {
        await creditos.lancar(tx, {
          companyId: EMPRESA,
          alunoId: ALUNO,
          valorCentavos: 1_000,
          motivo: '   ',
          autorId: UADMIN,
          acaoId,
        });
      });
    } catch (erro) {
      capturado = erro;
    }
    expect(codeDoErro(capturado)).toBe('MOTIVO_OBRIGATORIO');
    expect(await saldo()).toBe(antes);
  });

  it('`consumir` e `devolver` fecham o ciclo, e a devolução acha o consumo ATIVO', async () => {
    const acaoCriar = await novaAcao('reserva_criada');
    const antes = await saldo();

    const consumoId = await db.$transaction((tx) =>
      creditos.consumir(tx, {
        companyId: EMPRESA,
        alunoId: ALUNO,
        valorCentavos: 8_000,
        autorId: UADMIN,
        acaoId: acaoCriar,
        ocupacaoId: OCUPACAO,
      }),
    );
    expect(await saldo()).toBe(antes - 8_000);

    // O cancelamento não recebe o id do consumo de bandeja: ele descobre qual
    // é o ATIVO, que é a definição da INV-098 e o que faz a reativação
    // continuar possível.
    const ativo = await creditos.consumoAtivoDaOcupacao(db, EMPRESA, OCUPACAO);
    expect(ativo).toEqual({
      id: consumoId,
      alunoId: ALUNO,
      valorCentavos: 8_000,
    });

    const acaoCancelar = await novaAcao('credito_lancado');
    await db.$transaction((tx) =>
      creditos.devolver(tx, {
        companyId: EMPRESA,
        alunoId: ALUNO,
        valorCentavos: ativo!.valorCentavos,
        autorId: UADMIN,
        acaoId: acaoCancelar,
        ocupacaoId: OCUPACAO,
        movimentoOrigemId: ativo!.id,
      }),
    );
    expect(await saldo()).toBe(antes);

    // Devolvido, deixa de ser ativo — senão um segundo cancelamento devolveria
    // duas vezes.
    expect(
      await creditos.consumoAtivoDaOcupacao(db, EMPRESA, OCUPACAO),
    ).toBeNull();
  });

  it('devolução com valor DIFERENTE do consumo é recusada pela FK causal (D5)', async () => {
    // Não é o serviço que garante isto — é a FK de seis colunas. O teste
    // existe para provar que a garantia alcança o caminho do serviço, e não só
    // o SQL do ensaio.
    const acaoCriar = await novaAcao('reserva_criada');
    const consumoId = await db.$transaction((tx) =>
      creditos.consumir(tx, {
        companyId: EMPRESA,
        alunoId: ALUNO,
        valorCentavos: 3_000,
        autorId: UADMIN,
        acaoId: acaoCriar,
        ocupacaoId: OCUPACAO,
      }),
    );
    const acaoCancelar = await novaAcao('credito_lancado');
    await expect(
      db.$transaction((tx) =>
        creditos.devolver(tx, {
          companyId: EMPRESA,
          alunoId: ALUNO,
          valorCentavos: 3_001,
          autorId: UADMIN,
          acaoId: acaoCancelar,
          ocupacaoId: OCUPACAO,
          movimentoOrigemId: consumoId,
        }),
      ),
    ).rejects.toThrow(/movimentos_origem_causal_fkey|23503/);
  });

  it('o saldo NÃO se conserta por fora: `UPDATE` direto é recusado (INV-071)', async () => {
    // A sabotagem que este teste impede é a mais tentadora de todas — alguém
    // "arrumando" o saldo com um UPDATE em vez de lançar um movimento.
    await expect(
      q(`UPDATE alunos SET saldo_creditos = 999999 WHERE id = '${ALUNO}'`),
    ).rejects.toThrow(/INV-071|23514/);
  });
});
