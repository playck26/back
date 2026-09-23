import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { FilaDeEsperaService } from '../../src/fila-de-espera/fila-de-espera.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import type { MatriculaDoAlunoService } from '../../src/classes/matricula-do-aluno.service';
import type { ReposicaoService } from '../../src/classes/reposicao.service';

/**
 * SPEC-064/TASK-005 — **a rota de leitura da fila, que não existia.**
 *
 * ## Por que este arquivo existe
 *
 * A TASK-005 pedia *"Cliente: entrar, ver a vez e o prazo, confirmar"* e
 * declarava write-set `nada`. Ao implementá-la ficou claro que **não havia de
 * onde ler**: a fila só tinha escrita, e a caixa de avisos omite `origem_id`
 * por invariante (INV-065d). A LIM-064d promete que quem não tem push *"vê na
 * tela da fila"* — e a tela não tinha fonte.
 *
 * ## O caso que discrimina
 *
 * `vezAberta` **não é** `estado === 'chamado'`. A D8 diz que o varredor tem
 * interruptor e que, **mesmo desligado**, *"chamados vivos expiram na leitura:
 * a tela e a confirmação conferem `chamado_ate`"*. Uma linha pode estar
 * `chamado` no banco com o prazo vencido — e a tela não pode oferecer
 * "confirmar" para o que o servidor vai recusar com `VEZ_EXPIRADA`. É a
 * armadilha do DEF-011, e é o terceiro caso daqui.
 */
exigirBancoLocal();

const QUADRA = '06405000-0000-4000-8000-000000000002';
const TURMA = '06405000-0000-4000-8000-000000000003';
const USUARIO = '06405000-0000-4000-8000-000000000004';
const ALUNO = '06405000-0000-4000-8000-000000000005';
const PROFESSOR = '06405000-0000-4000-8000-000000000006';
const OCUPACAO = '06405000-0000-4000-8000-000000000007';
const EMPRESA_ID = '06405000-0000-4000-8000-000000000001';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

function servico(): FilaDeEsperaService {
  return new FilaDeEsperaService(
    db as unknown as PrismaService,
    {} as unknown as ConfigOperacaoService,
    {} as unknown as MatriculaDoAlunoService,
    {} as unknown as ReposicaoService,
  );
}

/** `AAAA-MM-DD` a `dias` de distância. */
function emDias(dias: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
const AULA = emDias(5);

let filaSeq = 0;
async function naFila(opcoes: {
  turma?: boolean;
  aula?: boolean;
  chamadoEm?: string;
}): Promise<string> {
  filaSeq += 1;
  const id = `06405000-0000-4000-8000-5000000000${String(filaSeq).padStart(2, '0')}`;
  const chamado = opcoes.chamadoEm
    ? `'chamado', now(), ${opcoes.chamadoEm}`
    : `'aguardando', NULL, NULL`;

  // **A fila de AULA exige o crédito**, e não é detalhe de fixture: o
  // `fila_credito_chk` recusa linha ativa sem `falta_id` (LIM-064e — sem
  // crédito, o chamado seria convite que a pessoa não pode cumprir). A
  // primeira versão deste arquivo não criava a falta e levou `23514`.
  let faltaId: string | null = null;
  if (opcoes.aula) {
    faltaId = `06405000-0000-4000-8000-4000000000${String(filaSeq).padStart(2, '0')}`;
    await q(
      `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at)
       VALUES ('${faltaId}','${EMPRESA_ID}','${OCUPACAO}','${ALUNO}',now())`,
    );
  }

  await q(
    `INSERT INTO lista_de_espera (id,company_id,aluno_id,turma_id,ocupacao_id,falta_id,estado,chamado_em,chamado_ate)
     VALUES ('${id}','${EMPRESA_ID}','${ALUNO}',
             ${opcoes.turma ? `'${TURMA}'` : 'NULL'},
             ${opcoes.aula ? `'${OCUPACAO}'` : 'NULL'},
             ${faltaId ? `'${faltaId}'` : 'NULL'},
             ${chamado})`,
  );
  return id;
}

async function montar(): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA_ID}','SPEC-064','spec-064-leitura',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA_ID}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${QUADRA}','${EMPRESA_ID}','Quadra Central',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA_ID}' LIMIT 1),80)`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${USUARIO}','fila064@teste.local','x','Aluno','aluno','${EMPRESA_ID}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES ('${ALUNO}','${USUARIO}','${EMPRESA_ID}','aprovado')`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome) VALUES ('${PROFESSOR}','${EMPRESA_ID}','Professor')`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,professor_id,capacidade,status) VALUES ('${TURMA}','${EMPRESA_ID}','Turma das Quintas','${QUADRA}','${PROFESSOR}',6,'ativa')`,
  );
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${OCUPACAO}','${EMPRESA_ID}','${QUADRA}','${AULA}','19:00','20:00','TURMA','${TURMA}','pendente_pagamento',now())`,
  );
}

beforeEach(async () => {
  filaSeq = 0;
  await limparEmpresa(db, EMPRESA_ID);
  await montar();
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA_ID);
  await db.$disconnect();
});

describe('SPEC-064/TASK-005 — GET das filas vivas do aluno', () => {
  it('a fila de TURMA volta com o alvo nomeado, e sem vez aberta', async () => {
    await naFila({ turma: true });

    const linhas = await servico().minhasLinhas(EMPRESA_ID, USUARIO);

    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      fila: 'turma',
      estado: 'aguardando',
      vezAberta: false,
      chamadoAte: null,
      turmaId: TURMA,
      turmaNome: 'Turma das Quintas',
      ocupacaoId: null,
      data: null,
    });
  });

  it('a fila de AULA traz dia, hora e quadra — o que a tela precisa dizer', async () => {
    await naFila({ aula: true });

    const [linha] = await servico().minhasLinhas(EMPRESA_ID, USUARIO);

    expect(linha).toMatchObject({
      fila: 'aula',
      ocupacaoId: OCUPACAO,
      data: AULA,
      horaInicio: '19:00',
      horaFim: '20:00',
      quadraNome: 'Quadra Central',
      // O nome vem da turma DA AULA, e não de uma segunda consulta na tela.
      turmaNome: 'Turma das Quintas',
    });
  });

  it('chamado DENTRO do prazo abre a vez; chamado VENCIDO não', async () => {
    // **O caso que discrimina, e a razão de `vezAberta` existir.** Os dois
    // estão `chamado` no banco. Se a tela olhasse só o estado, ofereceria
    // confirmação para uma vez que o servidor recusa com `VEZ_EXPIRADA` — e
    // o varredor, que é quem expira, tem interruptor (D8).
    const viva = await naFila({
      turma: true,
      chamadoEm: `now() + interval '6 hours'`,
    });
    const vencida = await naFila({
      aula: true,
      chamadoEm: `now() - interval '1 minute'`,
    });

    const linhas = await servico().minhasLinhas(EMPRESA_ID, USUARIO);
    const porId = new Map(linhas.map((l) => [l.id, l]));

    expect(porId.get(viva)?.estado).toBe('chamado');
    expect(porId.get(viva)?.vezAberta).toBe(true);

    expect(porId.get(vencida)?.estado).toBe('chamado');
    expect(porId.get(vencida)?.vezAberta).toBe(false);
    // O prazo continua visível: a tela precisa dizer "venceu quando".
    expect(porId.get(vencida)?.chamadoAte).not.toBeNull();
  });

  it('linha TERMINADA não é fila — some da lista', async () => {
    const ativa = await naFila({ turma: true });
    const morta = await naFila({ aula: true });
    await q(
      `UPDATE lista_de_espera SET estado='desistiu', concluida_em=now() WHERE id='${morta}'`,
    );

    const linhas = await servico().minhasLinhas(EMPRESA_ID, USUARIO);

    expect(linhas.map((l) => l.id)).toEqual([ativa]);
  });

  it('o recorte é por EMPRESA, e ele barra antes da consulta', async () => {
    // O `companyId` do token é o recorte. Aqui ele barra **no
    // `alunoDoUsuario`**: não existe aluno desse usuário na outra empresa,
    // então nem se chega ao `findMany`. É `404`, e não lista vazia — a mesma
    // regra da SPEC-023/INV-023b: distinguir "não é seu" de "não existe"
    // entregaria informação sobre o outro clube.
    await naFila({ turma: true });

    await expect(
      servico().minhasLinhas('06405000-0000-4000-8000-0000000000ff', USUARIO),
    ).rejects.toThrow();
  });
});
