/**
 * SPEC-054/AC-038 — **com a validação do DTO desligada, o `CHECK` do banco
 * responde `400 VALOR_INVALIDO`, nunca `500`.**
 *
 * "DTO desligado" = chamar o serviço direto, sem o `ValidationPipe`: é o que
 * aconteceria se DTO e `CHECK` divergissem. Pela API de modelo (o serviço) e por
 * SQL cru (a outra representação, passada ao mesmo classificador).
 *
 * **E o limite:** um `23514` de TRIGGER — o do item em reserva já confirmada —
 * não é `CHECK`, e o classificador o relança (S12).
 */
import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { AdicionaisService } from '../../src/courts/adicionais.service';
import { traduzirRecusaDoCatalogo } from '../../src/courts/recusas-do-catalogo';
import { sqlstateDoErro } from '../../src/courts/recusas-de-estoque';
import { TiposDeAdicionalService } from '../../src/courts/tipos-de-adicional.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const db = new PrismaClient();
const prisma = db as unknown as PrismaService;
const tipos = new TiposDeAdicionalService(prisma);
const adicionais = new AdicionaisService(prisma);
const config = new ConfigOperacaoService(prisma);

const EMPRESA = 'e0540000-0000-4000-8000-0000000000c1';
const UALUNO = 'e0540000-0000-4000-8000-0000000000c2';
const ALUNO = 'e0540000-0000-4000-8000-0000000000c3';
const QUADRA = 'e0540000-0000-4000-8000-0000000000c4';
const TIPO = 'e0540000-0000-4000-8000-0000000000c5';
const ADICIONAL = 'e0540000-0000-4000-8000-0000000000c6';

async function semear() {
  await limparEmpresa(db, EMPRESA);
  const q = (sql: string) => db.$executeRawUnsafe(sql);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','Clube 054 catalogo','clube-054-catalogo',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ('${UALUNO}','054c-aluno@t.local','x','Aluno','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id) VALUES ('${ALUNO}','${UALUNO}','${EMPRESA}')`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora)
     VALUES ('${QUADRA}','${EMPRESA}','Q1',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),100)`,
  );
  await q(
    `INSERT INTO tipos_de_adicional (id,company_id,nome) VALUES ('${TIPO}','${EMPRESA}','Raquetes')`,
  );
  await q(
    `INSERT INTO adicionais (id,company_id,tipo_id,nome,preco,estoque,updated_at)
     VALUES ('${ADICIONAL}','${EMPRESA}','${TIPO}','Raquete',15,2,now())`,
  );
}

beforeEach(semear);

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

/** A resposta da recusa — e FALHA se não houve recusa. */
async function recusa(promessa: Promise<unknown>) {
  try {
    await promessa;
  } catch (erro) {
    return {
      classe: (erro as Error).constructor.name,
      code: (
        (erro as { getResponse?: () => unknown }).getResponse?.() as
          { code?: string } | undefined
      )?.code,
    };
  }
  throw new Error('esperava recusa, e a operação passou');
}

const VALOR_INVALIDO = {
  classe: 'BadRequestException',
  code: 'VALOR_INVALIDO',
};

describe('SPEC-054/AC-038 — o CHECK do banco, sem o DTO na frente', () => {
  it('criar e renomear tipo com nome inválido → 400 VALOR_INVALIDO', async () => {
    expect(await recusa(tipos.criar(EMPRESA, { nome: ' Raquetes' }))).toEqual(
      VALOR_INVALIDO,
    );
    expect(
      await recusa(tipos.renomear(EMPRESA, TIPO, { nome: 'x'.repeat(31) })),
    ).toEqual(VALOR_INVALIDO);
  });

  it('criar adicional com nome, preço ou estoque inválido → 400 VALOR_INVALIDO', async () => {
    for (const invalido of [
      { nome: 'Raquete ' },
      { preco: 0 },
      { estoque: -1 },
    ]) {
      expect(
        await recusa(
          adicionais.criar(EMPRESA, {
            tipoId: TIPO,
            nome: 'Nova',
            preco: 10,
            estoque: 1,
            ...invalido,
          }),
        ),
      ).toEqual(VALOR_INVALIDO);
    }
  });

  it('editar adicional com preço ou estoque inválido → 400 VALOR_INVALIDO', async () => {
    expect(
      await recusa(adicionais.editar(EMPRESA, ADICIONAL, { preco: 0 })),
    ).toEqual(VALOR_INVALIDO);
    expect(
      await recusa(adicionais.editar(EMPRESA, ADICIONAL, { estoque: -1 })),
    ).toEqual(VALOR_INVALIDO);
  });

  it('PUT nomes-de-tipo com nome inválido → 400 VALOR_INVALIDO', async () => {
    expect(
      await recusa(
        config.gravarNomesDeTipo(EMPRESA, {
          nomeTipoQuadra: ' Espaço',
          nomeTipoAula: null,
        }),
      ),
    ).toEqual(VALOR_INVALIDO);
  });

  it('por SQL CRU (P2010 com meta.code 23514), o mesmo classificador dá a mesma resposta', async () => {
    let erro: unknown;
    try {
      await db.$executeRawUnsafe(
        `INSERT INTO adicionais (id,company_id,tipo_id,nome,preco,estoque,updated_at)
         VALUES (gen_random_uuid(),'${EMPRESA}','${TIPO}','Cru',0,1,now())`,
      );
    } catch (e) {
      erro = e;
    }
    expect(sqlstateDoErro(erro)).toBe('23514');
    await expect(
      traduzirRecusaDoCatalogo(erro, 'criar-adicional'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('S12: o 23514 de TRIGGER (item em reserva já confirmada) não é CHECK — o classificador RELANÇA', async () => {
    const [{ id }] = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,aluno_id,valor,updated_at)
       VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}','2035-06-07','09:00','10:00','AVULSO','${ALUNO}',100,now())
       RETURNING id::text AS id`,
    );
    let erro: unknown;
    try {
      await db.$executeRawUnsafe(
        `INSERT INTO adicionais_da_ocupacao (id,company_id,ocupacao_id,adicional_id,quantidade,valor_unitario)
         VALUES (gen_random_uuid(),'${EMPRESA}','${id}','${ADICIONAL}',1,15)`,
      );
    } catch (e) {
      erro = e;
    }
    // É mesmo 23514 — o que muda é a origem.
    expect(sqlstateDoErro(erro)).toBe('23514');
    await expect(
      traduzirRecusaDoCatalogo(erro, 'criar-adicional'),
    ).rejects.toBe(erro);
  });
});
