/**
 * DEF-025 — **empresa sem configuração de horário abria a tela em branco, e o
 * salvar respondia `400`.**
 *
 * ## O defeito, achado em uso local em 2026-09-10
 *
 * O Israel abriu a ficha de uma quadra no Admin e o bloco "Horário de
 * funcionamento" não tinha grade nenhuma — só o texto e o botão. Clicar em
 * "Salvar horários" respondia:
 *
 * ```
 * PUT /api/v1/courts/:id/horarios -> 400
 * {"message":["dias must contain at least 7 elements"]}
 * ```
 *
 * A cadeia inteira, medida antes de qualquer conserto:
 *
 * 1. a empresa não tinha **nenhuma** linha em `horarios_funcionamento`;
 * 2. `listarDaQuadra` devolvia `dias: []`;
 * 3. a tela renderizava zero linhas;
 * 4. o botão mandava de volta a lista vazia que recebeu, e o DTO — que exige
 *    exatamente sete — recusava.
 *
 * ## Por que ficou invisível até alguém abrir a tela
 *
 * **O caminho do ALUNO funcionava.** `resolverDeLinhas` tem rede de segurança
 * desde a SPEC-010: sem linha, devolve 6h–22h e a agenda aparece normal. Só a
 * tela de *configuração* ficava vazia — a leitura do aluno e a do gestor
 * discordavam sobre o mesmo estado do banco.
 *
 * **E o comentário de `CompaniesService` previu isto por escrito:** *"o admin
 * abriria a tela de configuração vazia e não entenderia de onde vêm os
 * horários que o aluno enxerga"*. O remédio de lá — semear na criação — só
 * cobre quem nasce pelo serviço; o `prisma/seed.ts` criava a empresa direto, e
 * qualquer empresa anterior à SPEC-010 chega aqui igual.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = 'd0250000-0000-4000-8000-000000000001';
const QUADRA = 'd0250000-0000-4000-8000-000000000002';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

function servico(): HorarioFuncionamentoService {
  return new HorarioFuncionamentoService(db as unknown as PrismaService);
}

/** Empresa e quadra **sem nenhuma linha** de horário — o estado do defeito. */
async function montar(): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','DEF-025','def-025-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${QUADRA}','${EMPRESA}','Quadra DEF-025',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),80)`,
  );
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await montar();
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('DEF-025 — empresa sem configuração de horário', () => {
  it('o estado do defeito existe mesmo: ZERO linhas', async () => {
    // Sem esta asserção, os casos abaixo poderiam estar medindo uma empresa
    // configurada e passariam por vacuidade.
    expect(
      await db.horarioFuncionamento.count({ where: { companyId: EMPRESA } }),
    ).toBe(0);
  });

  it('**a quadra devolve os SETE dias, e nunca lista vazia**', async () => {
    const r = await servico().listarDaQuadra(EMPRESA, QUADRA);

    // Era `dias: []`. A tela renderizava zero linhas, e o botão mandava de
    // volta a lista vazia que recebeu.
    expect(r.dias).toHaveLength(7);
    expect(r.dias.map((d) => d.diaSemana)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('a origem é `herdado`, e é a verdade', async () => {
    // Ela herda o padrão do SISTEMA (6h–22h), não o de uma configuração da
    // empresa que não existe. Dizer `proprio` faria o gestor achar que aquela
    // quadra foi configurada individualmente.
    expect((await servico().listarDaQuadra(EMPRESA, QUADRA)).origem).toBe(
      'herdado',
    );
  });

  it('os sete dias são ABERTOS 06:00–22:00 — o mesmo que o aluno já via', async () => {
    // **É a razão de o defeito ter ficado invisível:** `resolverDeLinhas` já
    // devolvia 6h–22h para o aluno. A tela do gestor precisa mostrar o mesmo,
    // senão as duas leituras discordam sobre o mesmo estado do banco.
    const r = await servico().listarDaQuadra(EMPRESA, QUADRA);
    // **O `toHaveLength` vem ANTES do laço, e não é redundância.** A primeira
    // versão deste caso só percorria `r.dias` — com a lista vazia o laço não
    // roda, e ele passava por VACUIDADE. Medido: sabotando a rede de
    // segurança, só um dos sete casos ficava vermelho; este continuava verde
    // sobre o defeito exato que existe para pegar.
    expect(r.dias).toHaveLength(7);
    for (const dia of r.dias) {
      expect(dia.fechado).toBe(false);
      expect(dia.horaInicio).toBe('06:00');
      expect(dia.horaFim).toBe('22:00');
    }
  });

  it('a tela de Configurações também recebe os sete', async () => {
    // Mesmo defeito, outra tela: `listarConfiguracao` alimenta o editor do
    // padrão da empresa, e `padrao: []` produziria o mesmo editor sem linhas.
    const r = await servico().listarConfiguracao(EMPRESA);
    expect(r.padrao).toHaveLength(7);
    // Nenhuma quadra tem horário PRÓPRIO — herança é ausência de registro, e
    // a rede de segurança não pode inventar override nenhum.
    expect(r.quadrasComHorarioProprio).toEqual([]);
  });

  it('**o que a empresa TEM gravado continua vencendo a rede**', async () => {
    // A rede só cobre ausência total. Uma empresa configurada não pode ver
    // 6h–22h por cima do que ela definiu — seria o defeito ao contrário, e
    // muito pior: silencioso e sobre dado de verdade.
    for (let dia = 0; dia < 7; dia++) {
      await q(
        `INSERT INTO horarios_funcionamento (id,company_id,quadra_id,dia_semana,fechado,hora_inicio,hora_fim,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}',NULL,${dia},false,'09:00','18:00',now())`,
      );
    }

    const r = await servico().listarDaQuadra(EMPRESA, QUADRA);
    expect(r.dias).toHaveLength(7);
    expect(r.dias[0].horaInicio).toBe('09:00');
    expect(r.dias[0].horaFim).toBe('18:00');
  });

  it('e o horário PRÓPRIO da quadra continua vencendo o da empresa', async () => {
    for (let dia = 0; dia < 7; dia++) {
      await q(
        `INSERT INTO horarios_funcionamento (id,company_id,quadra_id,dia_semana,fechado,hora_inicio,hora_fim,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}',NULL,${dia},false,'09:00','18:00',now())`,
      );
      await q(
        `INSERT INTO horarios_funcionamento (id,company_id,quadra_id,dia_semana,fechado,hora_inicio,hora_fim,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}',${dia},false,'07:00','23:00',now())`,
      );
    }

    const r = await servico().listarDaQuadra(EMPRESA, QUADRA);
    expect(r.origem).toBe('proprio');
    expect(r.dias[0].horaInicio).toBe('07:00');
  });
});
