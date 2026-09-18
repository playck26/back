/**
 * SPEC-057/TASK-001 (card 5361) — **o fechamento automático em banco real.**
 *
 * O que o BANCO garante sozinho está em `spec-057-presenca-automatica-banco`.
 * Aqui estão as provas que dependem do worker e dos serviços:
 *
 * - AC-001 — `M ∪ V` vira snapshot completo, automático e sem autor; duas
 *   instâncias não duplicam; GET→PUT aceita o visitante;
 * - AC-002 — cabeçalho existente, mesmo parcial ou legado, não é tocado;
 *   matrícula depois do fechamento não muda o snapshot;
 * - AC-004 (a parte de aplicação) — trava de credencial, corte, config
 *   ausente, pausa com lote aberto, retomada além de 7 dias, CLI;
 * - AC-007 — a corrida medida: abrir 13:30, tick 14:00, salvar 14:10;
 *   visitante muda a versão só onde ela depende de `M ∪ V ∪ S`;
 * - INV-144 — `desmarcar`, `PUT` e worker param na mesma raiz;
 * - AC-009/D8 — nada disso escreve falta avisada, reposição ou crédito.
 *
 * **Worker e serviços rodam pela conexão do login runtime** (`runtime`), não
 * pela sessão superusuário da suíte: é a prova de que o caminho da aplicação
 * não precisou de privilégio de owner — e é o que faz a trava de credencial
 * liberar o tick.
 */
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { cancelarOcupacaoNaFixture } from './cancelar-ocupacao';
import {
  CONEXAO_OPERADOR_DE_TESTE,
  CONEXAO_RUNTIME_DE_TESTE,
  LOGIN_OPERADOR_DE_TESTE,
  declararAmbienteDeTeste,
  garantirConexoesDeTeste,
  garantirLoginsDeTeste,
  ligarPresencaAutomatica,
  redefinirConfigDePresenca,
  urlDaConexaoDeTeste,
} from './config-de-presenca';
import {
  EMPRESA,
  TURMA_A,
  TURMA_B,
  TURMA_ORIGEM,
  UGESTOR,
  UPROF,
  aluno,
  aula,
  cabecalhoDe,
  chamadaCrua,
  codigoDe,
  db,
  desconectarTodos,
  diasAtras,
  esperarBloqueio,
  linhasDe,
  matricular,
  montarEmpresa,
  operador,
  q,
  reiniciarSequencias,
  respostaDe,
  runtime,
  runtime2,
  segurarTurma,
  soltarTodasAsTravas,
  visita,
} from './presenca-automatica-fixture';
import { PresencaService } from '../../src/classes/presenca.service';
import { ReposicaoService } from '../../src/classes/reposicao.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { FechamentoAutomaticoService } from '../../src/presenca-automatica/fechamento-automatico.service';
import { executarCli } from '../../src/presenca-automatica/cli/presenca-auto';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(240_000);
exigirBancoLocal();

const comoApp = (c: PrismaClient) => c as unknown as PrismaService;
const presenca = () => new PresencaService(comoApp(runtime));
const worker = (c: PrismaClient = runtime) =>
  new FechamentoAutomaticoService(comoApp(c));
const reposicoes = () =>
  new ReposicaoService(
    comoApp(runtime),
    new ConfigOperacaoService(comoApp(runtime)),
  );

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

afterEach(async () => {
  await soltarTodasAsTravas();
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await redefinirConfigDePresenca(db);
  await desconectarTodos();
});

/** Dois matriculados em TURMA_A e uma aula dela ontem; corte há 3 dias. */
async function cenarioBasico() {
  const a1 = await aluno('Ana');
  const a2 = await aluno('Bruno');
  await matricular(TURMA_A, a1.alunoId);
  await matricular(TURMA_A, a2.alunoId);
  const oc = await aula(TURMA_A, -1);
  await ligarPresencaAutomatica(db, diasAtras(3));
  return { a1, a2, oc };
}

async function contagemDeCredito() {
  const [linha] = await db.$queryRawUnsafe<{ faltas: bigint; repos: bigint }[]>(
    `SELECT (SELECT count(*) FROM faltas_avisadas WHERE company_id = $1::uuid) AS faltas,
            (SELECT count(*) FROM reposicoes_de_aula WHERE company_id = $1::uuid) AS repos`,
    EMPRESA,
  );
  return { faltas: Number(linha.faltas), repos: Number(linha.repos) };
}

// ======================================================================
describe('AC-001 — o fechamento automático grava M ∪ V', () => {
  it('snapshot completo, todos presentes, origem automática e autor nulo', async () => {
    const { a1, a2, oc } = await cenarioBasico();
    const visitante = await aluno('Visitante');
    await matricular(TURMA_ORIGEM, visitante.alunoId);
    await visita(visitante.alunoId, oc);

    const r = await worker().executarTick();

    expect(r.credencialSeparada).toBe(true);
    expect(r.habilitada).toBe(true);
    const cab = await cabecalhoDe(oc);
    expect(cab).toMatchObject({
      origem: 'automatica',
      origemInicial: 'automatica',
      registradaPor: null,
      completude: 'completa',
    });
    expect(cab?.fechada).toBeInstanceOf(Date);
    const linhas = await linhasDe(oc);
    expect(linhas.map((l) => l.alunoId).sort()).toEqual(
      [a1.alunoId, a2.alunoId, visitante.alunoId].sort(),
    );
    expect(
      linhas.every((l) => l.status === 'presente' && l.autor === null),
    ).toBe(true);
  });

  it('M ∩ V (matriculado que também repõe) entra UMA vez', async () => {
    const { a1, oc } = await cenarioBasico();
    await matricular(TURMA_ORIGEM, a1.alunoId);
    await visita(a1.alunoId, oc);

    await worker().executarTick();

    expect(await linhasDe(oc)).toHaveLength(2);
  });

  it('duas instâncias ao mesmo tempo: uma chamada, sem linha repetida nem filho parcial', async () => {
    const { oc } = await cenarioBasico();

    const [r1, r2] = await Promise.all([
      worker(runtime).executarTick(),
      worker(runtime2).executarTick(),
    ]);

    expect(r1.lotesFalhos + r2.lotesFalhos).toBe(0);
    expect(await linhasDe(oc)).toHaveLength(2);
    const [n] = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM chamadas WHERE ocupacao_id = $1::uuid`,
      oc,
    );
    expect(Number(n.n)).toBe(1);
  });

  it('GET→PUT sem cabeçalho aceita o visitante: sem ALUNO_REPETIDO, sem ALUNO_FORA_DA_TURMA', async () => {
    const { a1, a2, oc } = await cenarioBasico();
    const visitante = await aluno('Visitante');
    await matricular(TURMA_ORIGEM, visitante.alunoId);
    await visita(visitante.alunoId, oc);
    // M ∩ V também: a1 repõe na própria turma (entrou depois de marcar).
    await matricular(TURMA_ORIGEM, a1.alunoId);
    await visita(a1.alunoId, oc);

    const lida = await presenca().chamada(EMPRESA, UPROF, oc);
    const ids = lida.alunos.map((l) => l.alunoId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(
      [a1.alunoId, a2.alunoId, visitante.alunoId].sort(),
    );

    await expect(
      presenca().salvarChamada(
        EMPRESA,
        UPROF,
        oc,
        lida.versao,
        ids.map((alunoId) => ({ alunoId, status: 'presente' as const })),
      ),
    ).resolves.toMatchObject({ total: 3 });
  });
});

// ======================================================================
describe('AC-002 — o job nunca mexe em cabeçalho existente', () => {
  it.each([
    ['legado desconhecida, parcial', 'antigo', 'desconhecida'],
    ['humano completo', 'professor', 'completa'],
  ] as const)('%s: intacto depois do tick', async (_nome, tipo, completude) => {
    const { a1, oc } = await cenarioBasico();
    await chamadaCrua(oc, tipo, [[a1.alunoId, 'ausente']], { completude });
    const antes = await cabecalhoDe(oc);

    await worker().executarTick();

    expect(await cabecalhoDe(oc)).toEqual(antes);
    expect(await linhasDe(oc)).toHaveLength(1);
  });

  it('matrícula depois do fechamento não muda o snapshot nem a versão', async () => {
    const { oc } = await cenarioBasico();
    await worker().executarTick();
    const antes = await presenca().chamada(EMPRESA, UPROF, oc);

    const novo = await aluno('Chegou depois');
    await matricular(TURMA_A, novo.alunoId);
    const depois = await presenca().chamada(EMPRESA, UPROF, oc);

    expect(depois.versao).toBe(antes.versao);
    expect(depois.alunos.map((l) => l.alunoId)).toEqual(
      antes.alunos.map((l) => l.alunoId),
    );
  });
});

// ======================================================================
describe('AC-004 — o que a aplicação respeita da autoridade (D3)', () => {
  it('trava de credencial: como superusuário (owner) o tick não processa nada', async () => {
    const { oc } = await cenarioBasico();

    const r = await worker(db).executarTick();

    expect(r.credencialSeparada).toBe(false);
    expect(r.motivosDaCredencial).toContain('superusuario');
    expect(r.lotes).toBe(0);
    expect(await cabecalhoDe(oc)).toBeNull();
  });

  it('trava de credencial: com o login do operador o tick também não processa', async () => {
    const { oc } = await cenarioBasico();

    const r = await worker(operador).executarTick();

    expect(r.credencialSeparada).toBe(false);
    expect(r.motivosDaCredencial).toContain('executa_funcao_operacional');
    expect(await cabecalhoDe(oc)).toBeNull();
  });

  it('desativada (ambiente novo) não fecha nada', async () => {
    const a1 = await aluno('Ana');
    await matricular(TURMA_A, a1.alunoId);
    const oc = await aula(TURMA_A, -1);

    const r = await worker().executarTick();

    expect(r).toMatchObject({ credencialSeparada: true, habilitada: false });
    expect(await cabecalhoDe(oc)).toBeNull();
  });

  it('término em ou antes do corte fica fora (LIM-057a, sem backfill)', async () => {
    const a1 = await aluno('Ana');
    await matricular(TURMA_A, a1.alunoId);
    const antes = await aula(TURMA_A, -5);
    const depois = await aula(TURMA_A, -1);
    await ligarPresencaAutomatica(db, diasAtras(3));

    await worker().executarTick();

    expect(await cabecalhoDe(antes)).toBeNull();
    expect(await cabecalhoDe(depois)).not.toBeNull();
  });

  /**
   * **A fronteira exata, e ela veio de fora.** A validação independente de
   * 2026-09-17 mutou os dois predicados do worker de `> corte` para
   * `>= corte` e o teste acima **continuou verde**: a fixture tinha aula 5
   * dias antes e 1 dia depois de um corte de 3 dias, e nenhuma exatamente
   * nele. A implementação estava certa; a prova é que não cobria o único
   * ponto onde `>` e `>=` discordam.
   *
   * O corte é gravado a partir do término da própria aula, para que os dois
   * instantes sejam idênticos até o microssegundo — comparar datas montadas
   * à mão nos dois lados voltaria a deixar folga.
   */
  it('aula que termina EXATAMENTE no corte fica fora (o > não é >=)', async () => {
    const a1 = await aluno('Ana');
    await matricular(TURMA_A, a1.alunoId);
    const naFronteira = await aula(TURMA_A, -1);
    const [{ termino }] = await db.$queryRawUnsafe<{ termino: Date }[]>(
      `SELECT ((data + hora_fim) AT TIME ZONE 'America/Sao_Paulo') AS termino
         FROM ocupacoes_quadra WHERE id = $1::uuid`,
      naFronteira,
    );
    // Depois dela, para o tick ter o que fechar e a prova não passar por
    // vacuidade — se o job não rodar, as duas ficam nulas e o teste engana.
    const depois = await aula(TURMA_A, -1);
    await ligarPresencaAutomatica(db, new Date(termino));

    const r = await worker().executarTick();

    expect(await cabecalhoDe(naFronteira)).toBeNull();
    expect(await cabecalhoDe(depois)).not.toBeNull();
    expect(r.fechadas).toBeGreaterThanOrEqual(1);
  });

  it('aula cancelada e aula que terminou há menos de 1h ficam fora', async () => {
    const a1 = await aluno('Ana');
    await matricular(TURMA_A, a1.alunoId);
    const cancelada = await aula(TURMA_A, -1);
    await cancelarOcupacaoNaFixture(db, {
      companyId: EMPRESA,
      ocupacaoId: cancelada,
      autorId: UGESTOR,
    });
    const recente = await aula(TURMA_A, -1);
    await ligarPresencaAutomatica(db, diasAtras(3));
    const [termino] = await db.$queryRawUnsafe<{ t: Date }[]>(
      `SELECT ((data + hora_fim) AT TIME ZONE 'America/Sao_Paulo') AS t FROM ocupacoes_quadra WHERE id = $1::uuid`,
      recente,
    );

    // O relógio do tick fica 30 min depois do término da `recente`.
    await worker().executarTick({
      agora: new Date(new Date(termino.t).getTime() + 30 * 60 * 1000),
    });
    expect(await cabecalhoDe(recente)).toBeNull();
    expect(await cabecalhoDe(cancelada)).toBeNull();

    // E 61 min depois ela entra; a cancelada continua fora.
    await worker().executarTick({
      agora: new Date(new Date(termino.t).getTime() + 61 * 60 * 1000),
    });
    expect(await cabecalhoDe(recente)).not.toBeNull();
    expect(await cabecalhoDe(cancelada)).toBeNull();
  });

  it('linha de configuração ausente: o job desliga com erro e não insere a linha', async () => {
    const { oc } = await cenarioBasico();
    await q(
      'ALTER TABLE public.config_presenca_automatica DISABLE TRIGGER USER',
    );
    await q('DELETE FROM public.config_presenca_automatica');
    await q(
      'ALTER TABLE public.config_presenca_automatica ENABLE TRIGGER USER',
    );

    const r = await worker().executarTick();

    expect(r).toMatchObject({
      credencialSeparada: true,
      configPresente: false,
    });
    expect(await cabecalhoDe(oc)).toBeNull();
    const [n] = await db.$queryRawUnsafe<{ n: bigint }[]>(
      'SELECT count(*) AS n FROM public.config_presenca_automatica',
    );
    expect(Number(n.n)).toBe(0);
  });

  it('pausa com lote aberto: a pausa não espera, o lote termina, o seguinte não começa', async () => {
    const a1 = await aluno('Ana');
    await matricular(TURMA_A, a1.alunoId);
    await matricular(TURMA_B, a1.alunoId);
    const ocA = await aula(TURMA_A, -1);
    const ocB = await aula(TURMA_B, -1);
    await ligarPresencaAutomatica(db, diasAtras(3));
    const [{ instancia }] = await db.$queryRawUnsafe<{ instancia: string }[]>(
      'SELECT instancia_id::text AS instancia FROM public.config_presenca_automatica',
    );

    const trava = await segurarTurma(TURMA_A);
    let tickTerminou = false;
    const tick = worker()
      .executarTick()
      .finally(() => {
        tickTerminou = true;
      });
    await esperarBloqueio(CONEXAO_RUNTIME_DE_TESTE);

    // Pausa pela função, como o operador — enquanto o lote está parado na raiz.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${LOGIN_OPERADOR_DE_TESTE}`);
      await tx.$queryRawUnsafe(
        `SELECT o_mudou FROM public.presenca_auto_alterar($1::uuid, 'teste', false)`,
        instancia,
      );
    });
    expect(tickTerminou).toBe(false);

    trava.soltar();
    await trava.fim;
    const r = await tick;

    expect(await cabecalhoDe(ocA)).not.toBeNull();
    expect(await cabecalhoDe(ocB)).toBeNull();
    expect(r.lotes).toBeGreaterThanOrEqual(1);
  });

  it('retomada além de 7 dias: fecha a aula antiga e ela fica corrigível por 7 dias desde o fechamento', async () => {
    const a1 = await aluno('Ana');
    const a2 = await aluno('Bruno');
    await matricular(TURMA_A, a1.alunoId);
    await matricular(TURMA_A, a2.alunoId);
    const antiga = await aula(TURMA_A, -10);
    await ligarPresencaAutomatica(db, diasAtras(12));

    await worker().executarTick();
    const lida = await presenca().chamada(EMPRESA, UPROF, antiga);
    expect(lida.origemInicial).toBe('automatica');
    expect(lida.corrigivelAte).not.toBeNull();

    // A aula tem 10 dias — pela janela da data ela seria AULA_ANTIGA.
    await expect(
      presenca().salvarChamada(EMPRESA, UPROF, antiga, lida.versao, [
        { alunoId: a1.alunoId, status: 'presente' },
        { alunoId: a2.alunoId, status: 'ausente' },
      ]),
    ).resolves.toBeDefined();
  });
});

// ======================================================================
describe('AC-007 — a corrida medida e a versão com visitante', () => {
  it('abrir 13:30, tick 14:00, salvar 14:10 → 409 com fechamentoAutomatico; revisar e salvar ratifica', async () => {
    const { a1, a2, oc } = await cenarioBasico();

    // 13:30 — o professor abre a chamada ainda sem cabeçalho.
    const aberta = await presenca().chamada(EMPRESA, UPROF, oc);
    expect(aberta.completude).toBeNull();
    // 14:00 — o tick fecha.
    await worker().executarTick();
    const fechada = await cabecalhoDe(oc);

    // 14:10 — o professor salva com a versão de 13:30.
    const recusa = await respostaDe(
      presenca().salvarChamada(EMPRESA, UPROF, oc, aberta.versao, [
        { alunoId: a1.alunoId, status: 'presente' },
        { alunoId: a2.alunoId, status: 'ausente' },
      ]),
    );
    expect(recusa).toMatchObject({
      code: 'CHAMADA_DESATUALIZADA',
      fechamentoAutomatico: true,
    });
    expect(String((recusa as { message: string }).message)).toContain(
      'fechada automaticamente',
    );
    // Nada gravado pela tentativa vencida.
    expect(await cabecalhoDe(oc)).toEqual(fechada);

    // Revisar a versão atual (GET) e salvar de novo: ratifica.
    const revisada = await presenca().chamada(EMPRESA, UPROF, oc);
    expect(revisada.origem).toBe('automatica');
    await presenca().salvarChamada(EMPRESA, UPROF, oc, revisada.versao, [
      { alunoId: a1.alunoId, status: 'presente' },
      { alunoId: a2.alunoId, status: 'ausente' },
    ]);

    const ratificada = await cabecalhoDe(oc);
    expect(ratificada).toMatchObject({
      origem: 'professor',
      origemInicial: 'automatica',
      registradaPor: UPROF,
    });
    expect(ratificada?.fechada?.getTime()).toBe(fechada?.fechada?.getTime());
    const linhas = await linhasDe(oc);
    expect(linhas.every((l) => l.autor === UPROF)).toBe(true);
    expect(linhas.find((l) => l.alunoId === a2.alunoId)?.status).toBe(
      'ausente',
    );
  });

  it('abrir DEPOIS do tick salva direto', async () => {
    const { a1, a2, oc } = await cenarioBasico();
    await worker().executarTick();
    const lida = await presenca().chamada(EMPRESA, UPROF, oc);

    expect(
      await codigoDe(
        presenca().salvarChamada(EMPRESA, UPROF, oc, lida.versao, [
          { alunoId: a1.alunoId, status: 'presente' },
          { alunoId: a2.alunoId, status: 'presente' },
        ]),
      ),
    ).toBe('ok');
  });

  it('409 sobre chamada humana não atribui a mudança ao fechamento automático', async () => {
    const { a1, a2, oc } = await cenarioBasico();
    const aberta = await presenca().chamada(EMPRESA, UPROF, oc);
    await chamadaCrua(oc, 'professor', [
      [a1.alunoId, 'presente'],
      [a2.alunoId, 'presente'],
    ]);

    expect(
      await respostaDe(
        presenca().salvarChamada(EMPRESA, UPROF, oc, aberta.versao, [
          { alunoId: a1.alunoId, status: 'presente' },
          { alunoId: a2.alunoId, status: 'presente' },
        ]),
      ),
    ).toMatchObject({
      code: 'CHAMADA_DESATUALIZADA',
      fechamentoAutomatico: false,
    });
  });

  it('visitante marcado/desmarcado muda a versão SEM cabeçalho, e não muda a de snapshot completo', async () => {
    const { a1, a2, oc } = await cenarioBasico();
    const visitante = await aluno('Visitante');
    await matricular(TURMA_ORIGEM, visitante.alunoId);

    const v1 = (await presenca().chamada(EMPRESA, UPROF, oc)).versao;
    const { reposicaoId } = await visita(visitante.alunoId, oc);
    const v2 = (await presenca().chamada(EMPRESA, UPROF, oc)).versao;
    expect(v2).not.toBe(v1);
    // PUT com a versão de antes do visitante é 409, não 422.
    expect(
      await codigoDe(
        presenca().salvarChamada(EMPRESA, UPROF, oc, v1, [
          { alunoId: a1.alunoId, status: 'presente' },
          { alunoId: a2.alunoId, status: 'presente' },
        ]),
      ),
    ).toBe('CHAMADA_DESATUALIZADA');

    await presenca().salvarChamada(EMPRESA, UPROF, oc, v2, [
      { alunoId: a1.alunoId, status: 'presente' },
      { alunoId: a2.alunoId, status: 'presente' },
      { alunoId: visitante.alunoId, status: 'presente' },
    ]);
    const v3 = (await presenca().chamada(EMPRESA, UPROF, oc)).versao;

    const outro = await aluno('Outro visitante');
    await matricular(TURMA_ORIGEM, outro.alunoId);
    await visita(outro.alunoId, oc);
    expect((await presenca().chamada(EMPRESA, UPROF, oc)).versao).toBe(v3);
    await q(`DELETE FROM reposicoes_de_aula WHERE id = '${reposicaoId}'`);
    expect((await presenca().chamada(EMPRESA, UPROF, oc)).versao).toBe(v3);
  });
});

// ======================================================================
describe('INV-144 — worker, PUT e desmarcar param na mesma raiz', () => {
  it('o worker espera quem segura a turma, e relê: aula que ganhou chamada humana não é tocada', async () => {
    const { a1, a2, oc } = await cenarioBasico();
    const trava = await segurarTurma(TURMA_A);
    const tick = worker().executarTick();
    await esperarBloqueio(CONEXAO_RUNTIME_DE_TESTE);

    // Enquanto o worker espera, uma chamada humana chega (por fora da raiz,
    // só na fixture) — a releitura sob o lock é o que precisa enxergá-la.
    await chamadaCrua(oc, 'professor', [
      [a1.alunoId, 'ausente'],
      [a2.alunoId, 'ausente'],
    ]);
    trava.soltar();
    await trava.fim;
    const r = await tick;

    expect(r.ignoradas).toBeGreaterThanOrEqual(1);
    expect(await cabecalhoDe(oc)).toMatchObject({ origem: 'professor' });
    expect((await linhasDe(oc)).every((l) => l.status === 'ausente')).toBe(
      true,
    );
  });

  it('desmarcar reposição toma turmas FOR UPDATE antes de apagar', async () => {
    const visitante = await aluno('Visitante');
    await matricular(TURMA_ORIGEM, visitante.alunoId);
    const futura = await aula(TURMA_A, 6);
    const { reposicaoId } = await visita(visitante.alunoId, futura);

    const trava = await segurarTurma(TURMA_A);
    let terminou = false;
    const desmarcar = reposicoes()
      .desmarcar(EMPRESA, visitante.usuarioId, reposicaoId)
      .finally(() => {
        terminou = true;
      });
    await esperarBloqueio(CONEXAO_RUNTIME_DE_TESTE);
    expect(terminou).toBe(false);

    trava.soltar();
    await trava.fim;
    await desmarcar;
    const [n] = await db.$queryRawUnsafe<{ n: bigint }[]>(
      'SELECT count(*) AS n FROM reposicoes_de_aula WHERE id = $1::uuid',
      reposicaoId,
    );
    expect(Number(n.n)).toBe(0);
  });
});

// ======================================================================
describe('AC-009/D8 — fechar e ratificar não tocam falta avisada, reposição nem crédito', () => {
  it('contagens e crédito do visitante iguais antes e depois', async () => {
    const { a1, a2, oc } = await cenarioBasico();
    const visitante = await aluno('Visitante');
    await matricular(TURMA_ORIGEM, visitante.alunoId);
    await visita(visitante.alunoId, oc);
    // a1 avisou falta nesta aula: continua presumido presente (LIM-057m).
    await q(
      `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','${oc}','${a1.alunoId}',now())`,
    );
    const antes = await contagemDeCredito();
    const creditoAntes = await reposicoes().meuCredito(
      EMPRESA,
      visitante.usuarioId,
    );

    await worker().executarTick();
    expect(
      (await linhasDe(oc)).find((l) => l.alunoId === a1.alunoId)?.status,
    ).toBe('presente');
    const lida = await presenca().chamada(EMPRESA, UPROF, oc);
    await presenca().salvarChamada(EMPRESA, UPROF, oc, lida.versao, [
      { alunoId: a1.alunoId, status: 'ausente' },
      { alunoId: a2.alunoId, status: 'presente' },
      { alunoId: visitante.alunoId, status: 'presente' },
    ]);

    expect(await contagemDeCredito()).toEqual(antes);
    expect(await reposicoes().meuCredito(EMPRESA, visitante.usuarioId)).toEqual(
      creditoAntes,
    );
  });
});

// ======================================================================
describe('AC-004 — a CLI operacional', () => {
  const saida: string[] = [];
  const cli = (argv: string[], env: Record<string, string | undefined>) => {
    saida.length = 0;
    const conectados: PrismaClient[] = [];
    return executarCli(argv, {
      env,
      conectar: (url) => {
        const c = new PrismaClient({ datasources: { db: { url } } });
        conectados.push(c);
        return c;
      },
      escrever: (l) => saida.push(l),
    }).then((codigo) => ({ codigo, conectou: conectados.length > 0 }));
  };
  const urlDoOperador = urlDaConexaoDeTeste(CONEXAO_OPERADOR_DE_TESTE);
  const configAtual = () =>
    db.$queryRawUnsafe<unknown[]>(
      'SELECT * FROM public.config_presenca_automatica',
    );

  it('status só lê e não imprime host, usuário, senha nem URL', async () => {
    await declararAmbienteDeTeste(db);
    const antes = await configAtual();

    const r = await cli(['--', 'status'], {
      PRESENCA_OPERADOR_DATABASE_URL: urlDoOperador,
      APP_ENVIRONMENT: 'teste',
    });

    expect(r.codigo).toBe(0);
    expect(await configAtual()).toEqual(antes);
    const texto = saida.join('\n');
    const url = new URL(urlDoOperador);
    expect(texto).toContain('pode_alterar:          sim');
    expect(texto).toContain('ambiente declarado:    teste');
    for (const segredo of [
      url.hostname,
      url.username,
      url.password,
      'postgres',
    ]) {
      expect(texto).not.toContain(segredo);
    }
  });

  it('sem PRESENCA_OPERADOR_DATABASE_URL sai 1 sem conectar, mesmo com DATABASE_URL', async () => {
    const r = await cli(['status'], {
      DATABASE_URL: process.env.DATABASE_URL,
      MIGRATION_DATABASE_URL: process.env.DATABASE_URL,
    });
    expect(r).toEqual({ codigo: 1, conectou: false });
  });

  it('--ambiente diferente de APP_ENVIRONMENT sai 1 sem conectar', async () => {
    const r = await cli(
      [
        'ativar',
        '--ambiente',
        'producao',
        '--instancia',
        '05720000-0000-4000-8000-000000000099',
      ],
      {
        PRESENCA_OPERADOR_DATABASE_URL: urlDoOperador,
        APP_ENVIRONMENT: 'teste',
      },
    );
    expect(r).toEqual({ codigo: 1, conectou: false });
  });

  it('UUID errado → PA001 como erro operacional, exit 1, zero mutação', async () => {
    await declararAmbienteDeTeste(db);
    const antes = await configAtual();

    const r = await cli(
      [
        'ativar',
        '--ambiente',
        'teste',
        '--instancia',
        '05720000-0000-4000-8000-000000000099',
      ],
      {
        PRESENCA_OPERADOR_DATABASE_URL: urlDoOperador,
        APP_ENVIRONMENT: 'teste',
      },
    );

    expect(r.codigo).toBe(1);
    expect(saida.join('\n')).toContain('PRESENCA_INSTANCIA_DIVERGENTE');
    expect(await configAtual()).toEqual(antes);
  });

  it('ativar pela função fixa o corte; ativar de novo é "sem mudança" com o mesmo corte', async () => {
    await declararAmbienteDeTeste(db);
    const [{ instancia }] = await db.$queryRawUnsafe<{ instancia: string }[]>(
      'SELECT instancia_id::text AS instancia FROM public.config_presenca_automatica',
    );
    const env = {
      PRESENCA_OPERADOR_DATABASE_URL: urlDoOperador,
      APP_ENVIRONMENT: 'teste',
    };
    const args = ['ativar', '--ambiente', 'teste', '--instancia', instancia];

    expect((await cli(args, env)).codigo).toBe(0);
    const [primeira] = await db.$queryRawUnsafe<{ ativada_em: Date }[]>(
      'SELECT ativada_em FROM public.config_presenca_automatica',
    );
    expect(primeira.ativada_em).toBeInstanceOf(Date);

    expect((await cli(args, env)).codigo).toBe(0);
    expect(saida.join('\n')).toContain('sem mudança');
    const [segunda] = await db.$queryRawUnsafe<{ ativada_em: Date }[]>(
      'SELECT ativada_em FROM public.config_presenca_automatica',
    );
    expect(segunda.ativada_em.getTime()).toBe(primeira.ativada_em.getTime());
  });

  it('com a credencial do runtime no lugar da do operador: 42501, exit 1', async () => {
    await declararAmbienteDeTeste(db);
    const [{ instancia }] = await db.$queryRawUnsafe<{ instancia: string }[]>(
      'SELECT instancia_id::text AS instancia FROM public.config_presenca_automatica',
    );
    const r = await cli(
      ['ativar', '--ambiente', 'teste', '--instancia', instancia],
      {
        PRESENCA_OPERADOR_DATABASE_URL: urlDaConexaoDeTeste(
          CONEXAO_RUNTIME_DE_TESTE,
        ),
        APP_ENVIRONMENT: 'teste',
      },
    );
    expect(r.codigo).toBe(1);
    expect(saida.join('\n')).toContain('PRESENCA_SEM_PRIVILEGIO');
  });
});
