/**
 * SPEC-045 — **quem vence, e quem já venceu.**
 *
 * ## O que este arquivo existe para provar
 *
 * Dois casos, e só eles distinguem a implementação certa da ingênua:
 *
 * - **AC-004, o upgrade.** A LIM-037c aceita sobreposição de propósito
 *   (*"upgrade de plano no meio do mês é o caso normal"*). Uma consulta por
 *   `fim BETWEEN hoje AND hoje+N` devolveria como vencida a matrícula ANTIGA
 *   de quem acabou de fazer upgrade — e o gestor ligaria cobrando renovação de
 *   quem já renovou.
 * - **AC-005, o próximo já comprado.** Quem comprou o plano seguinte antes de
 *   o atual acabar não está vencendo.
 *
 * **Todos os outros casos passam com a consulta ingênua.** É por isso que a
 * sabotagem registrada na spec é trocar a implementação por ela: os dois casos
 * acima precisam ficar vermelhos, e os demais verdes. Sem esse arranjo, este
 * arquivo seria decoração.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { MatriculasService } from '../../src/matriculas/matriculas.service';
import { StudentsService } from '../../src/people/students.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = '04500000-0000-4000-8000-000000000001';
const ADMIN = '04500000-0000-4000-8000-000000000002';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

function servico(): MatriculasService {
  const p = db as unknown as PrismaService;
  return new MatriculasService(p, new StudentsService(p));
}

/** `hoje` no fuso do clube, que é o mesmo corte que o serviço usa. */
function emDias(dias: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

let seq = 0;

/** Um aluno ativo, com conta. Devolve o `alunoId`. */
async function aluno(nome: string): Promise<string> {
  seq += 1;
  const usuarioId = `04500000-0000-4000-8000-1000000000${String(seq).padStart(2, '0')}`;
  const alunoId = `04500000-0000-4000-8000-2000000000${String(seq).padStart(2, '0')}`;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','spec045.${seq}@x.com','h','${nome}','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${alunoId}','${usuarioId}','${EMPRESA}','aprovado','ativo')`,
  );
  // **A INV-114 recusou a primeira versao desta fixture** com `23503
  // matriculas_contrato_aceito_fkey`: nao ha matricula sem o contrato aceito
  // por AQUELE usuario naquela versao, e quem garante e a FK composta apontando
  // para a coluna gerada (SPEC-037). O teste nao conseguiu trapacear porque a
  // invariante e real -- terceira vez neste ciclo que o banco corrige uma
  // fixture minha.
  await q(
    `INSERT INTO aceites (id,usuario_id,tipo,versao,aceito_em) VALUES (gen_random_uuid(),'${usuarioId}','contrato',1,now())`,
  );
  return alunoId;
}

let planoSeq = 0;
async function plano(nome: string): Promise<string> {
  planoSeq += 1;
  const id = `04500000-0000-4000-8000-3000000000${String(planoSeq).padStart(2, '0')}`;
  await q(
    `INSERT INTO planos (id,company_id,nome,valor_centavos,prazo_meses,ativo,updated_at) VALUES ('${id}','${EMPRESA}','${nome}',10000,1,true,now())`,
  );
  return id;
}

/**
 * Uma matrícula com `inicio`/`fim` escolhidos, escrita **direto**.
 *
 * `MatriculasService.criar` calcula o `fim` a partir do prazo do plano e exige
 * contrato aceito — os dois atrapalham aqui, porque o que estes casos precisam
 * é de datas EXATAS em volta de hoje. O `INSERT` é o arranjo certo, e não um
 * atalho: nenhum dos casos afere a criação.
 */
let matSeq = 0;
async function matricula(
  alunoId: string,
  planoId: string,
  inicio: string,
  fim: string,
): Promise<void> {
  matSeq += 1;
  const id = `04500000-0000-4000-8000-4000000000${String(matSeq).padStart(2, '0')}`;
  const usuario = await db.aluno.findUniqueOrThrow({
    where: { id: alunoId },
    select: { usuarioId: true },
  });
  await q(
    `INSERT INTO matriculas (id,company_id,aluno_id,usuario_id,plano_id,valor_centavos,valor_de_tabela_centavos,prazo_meses,inicio,fim,contrato_versao,criado_por_id)
     VALUES ('${id}','${EMPRESA}','${alunoId}','${usuario.usuarioId}','${planoId}',10000,10000,1,'${inicio}','${fim}',1,'${ADMIN}')`,
  );
}

const nomes = (linhas: { alunoNome: string }[]) =>
  linhas.map((l) => l.alunoNome).sort();

async function montar(): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,contrato_versao_vigente,updated_at) VALUES ('${EMPRESA}','SPEC-045','spec-045-${EMPRESA}',1,now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${ADMIN}','admin.spec045@x.com','h','Admin','company_admin','${EMPRESA}',now())`,
  );
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  seq = 0;
  planoSeq = 0;
  matSeq = 0;
  await montar();
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-045 — vencimento de matrícula', () => {
  // =====================================================================
  // Os dois casos que definem a spec (D2)
  // =====================================================================

  it('**AC-004: quem fez UPGRADE não aparece como vencido**', async () => {
    const p = await plano('Mensal');
    const a = await aluno('Fez Upgrade');
    // A antiga terminou ontem...
    await matricula(a, p, emDias(-40), emDias(-1));
    // ...e a nova já estava valendo há uma semana. É o caso normal do upgrade.
    await matricula(a, p, emDias(-7), emDias(60));

    const r = await servico().vencimentos(EMPRESA, 30);

    // A consulta ingênua (`fim` na janela) poria a matrícula ANTIGA em
    // `vencidas`, e o gestor cobraria renovação de quem acabou de renovar.
    expect(nomes(r.vencidas)).toEqual([]);
    expect(nomes(r.vencendo)).toEqual([]);
  });

  it('**AC-005: quem já comprou o PRÓXIMO não aparece como vencendo**', async () => {
    const p = await plano('Mensal');
    const a = await aluno('Ja Comprou');
    // A vigente termina em 10 dias — dentro da janela de 30...
    await matricula(a, p, emDias(-20), emDias(10));
    // ...mas a seguinte já existe e vai até bem depois.
    await matricula(a, p, emDias(11), emDias(70));

    const r = await servico().vencimentos(EMPRESA, 30);

    expect(nomes(r.vencendo)).toEqual([]);
    expect(nomes(r.vencidas)).toEqual([]);
  });

  // =====================================================================
  // Os baldes
  // =====================================================================

  it('quem venceu e não renovou está em `vencidas`', async () => {
    const p = await plano('Mensal');
    const a = await aluno('Venceu');
    await matricula(a, p, emDias(-40), emDias(-5));

    const r = await servico().vencimentos(EMPRESA, 30);

    expect(nomes(r.vencidas)).toEqual(['Venceu']);
    expect(r.vencidas[0].diasRestantes).toBe(-5);
  });

  it('quem vence dentro da janela está em `vencendo`', async () => {
    const p = await plano('Mensal');
    const a = await aluno('Vence Logo');
    await matricula(a, p, emDias(-20), emDias(6));

    const r = await servico().vencimentos(EMPRESA, 30);

    expect(nomes(r.vencendo)).toEqual(['Vence Logo']);
    expect(r.vencendo[0].diasRestantes).toBe(6);
  });

  it('quem vence DEPOIS da janela não aparece', async () => {
    const p = await plano('Mensal');
    const a = await aluno('Tranquilo');
    await matricula(a, p, emDias(-10), emDias(90));

    const r = await servico().vencimentos(EMPRESA, 30);

    expect(nomes(r.vencendo)).toEqual([]);
  });

  it('a janela é o parâmetro, e ele MOVE a lista', async () => {
    const p = await plano('Mensal');
    const a = await aluno('Vence Em 45');
    await matricula(a, p, emDias(-10), emDias(45));

    // Sem este par, `dias` poderia estar sendo ignorado e os outros casos
    // continuariam verdes com a janela fixa em 30.
    expect(nomes((await servico().vencimentos(EMPRESA, 30)).vencendo)).toEqual(
      [],
    );
    expect(nomes((await servico().vencimentos(EMPRESA, 60)).vencendo)).toEqual([
      'Vence Em 45',
    ]);
  });

  // =====================================================================
  // Quem fica de fora, e por quê
  // =====================================================================

  it('AC-006: aluno DESLIGADO não é pendência de renovação', async () => {
    const p = await plano('Mensal');
    const a = await aluno('Desligado');
    await matricula(a, p, emDias(-40), emDias(-5));
    await q(`UPDATE alunos SET status='inativo' WHERE id='${a}'`);

    // Ele saiu do clube (DEF-027). Cobrar renovação de quem foi desligado é a
    // mesma incoerência que o DEF-027 fechou do outro lado.
    expect(nomes((await servico().vencimentos(EMPRESA, 30)).vencidas)).toEqual(
      [],
    );
  });

  it('AC-007: aluno que NUNCA teve matrícula não aparece (D4)', async () => {
    await aluno('Nunca Teve');

    const r = await servico().vencimentos(EMPRESA, 30);

    // O clube pode ter aluno que só aluga quadra. Incluí-lo faria dele uma
    // pendência todo mês, para sempre.
    expect(r.vencidas).toEqual([]);
    expect(r.vencendo).toEqual([]);
  });

  it('quem comprou só o plano do mês QUE VEM não é vencido', async () => {
    const p = await plano('Mensal');
    const a = await aluno('So Futuro');
    // Nada vigente hoje, mas resolvido: começa daqui a três dias.
    await matricula(a, p, emDias(3), emDias(40));

    const r = await servico().vencimentos(EMPRESA, 30);

    expect(nomes(r.vencidas)).toEqual([]);
    expect(nomes(r.vencendo)).toEqual([]);
  });

  it('empresa vizinha não entra na lista', async () => {
    const p = await plano('Mensal');
    const a = await aluno('Da Casa');
    await matricula(a, p, emDias(-40), emDias(-5));

    // A trava de tenant vive no `where`, e um `where` sem `companyId` passaria
    // em todos os outros casos deste arquivo.
    const r = await servico().vencimentos(
      '04500000-0000-4000-8000-00000000ffff',
      30,
    );
    expect(r.vencidas).toEqual([]);
  });

  // =====================================================================
  // A ordem (AC-008)
  // =====================================================================

  it('AC-008: cada grupo vem ordenado por `fim` ascendente', async () => {
    const p = await plano('Mensal');
    const a1 = await aluno('Venceu Ha Muito');
    const a2 = await aluno('Venceu Ontem');
    const a3 = await aluno('Vence Depois');
    const a4 = await aluno('Vence Amanha');
    await matricula(a1, p, emDias(-60), emDias(-20));
    await matricula(a2, p, emDias(-40), emDias(-1));
    await matricula(a3, p, emDias(-10), emDias(25));
    await matricula(a4, p, emDias(-10), emDias(1));

    const r = await servico().vencimentos(EMPRESA, 30);

    // Sem `sort`, a ordem seria a de iteração do `Map` — estável, mas por
    // ordem de INSERÇÃO, que não tem nada a ver com urgência.
    expect(r.vencidas.map((l) => l.alunoNome)).toEqual([
      'Venceu Ha Muito',
      'Venceu Ontem',
    ]);
    expect(r.vencendo.map((l) => l.alunoNome)).toEqual([
      'Vence Amanha',
      'Vence Depois',
    ]);
  });

  it('AC-002: a linha traz o bastante para agir sem abrir a ficha', async () => {
    const p = await plano('Trimestral');
    const a = await aluno('Precisa Renovar');
    await matricula(a, p, emDias(-40), emDias(3));

    const [linha] = (await servico().vencimentos(EMPRESA, 30)).vencendo;

    expect(linha).toEqual({
      alunoId: a,
      alunoNome: 'Precisa Renovar',
      planoNome: 'Trimestral',
      fim: emDias(3),
      diasRestantes: 3,
    });
  });
});
