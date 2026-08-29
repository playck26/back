/**
 * SPEC-024 — **FIT-011: o registro que a spec existe para criar.**
 *
 * O que está em julgamento aqui não é a tela: é a pergunta *"o que esta
 * pessoa aceitou, e quando?"*. Ela só tem resposta se o texto for
 * versionado, se a versão antiga continuar legível depois de publicar a
 * nova, e se aceitar duas vezes não virar duas linhas.
 *
 * **Nada disso se prova com dublê.** A idempotência é uma UNIQUE do banco; a
 * legibilidade da versão antiga é uma linha que precisa continuar lá; e as
 * duas escritas (coluna desnormalizada + `aceites`) só são "a mesma verdade"
 * se a transação for real.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { AceitesService } from '../../src/aceites/aceites.service';
import { TERMO_VERSAO_VIGENTE } from '../../src/aceites/termo-vigente';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const EMPRESA = 'f0110000-0000-4000-8000-000000000001';
const USUARIO = 'f0110000-0000-4000-8000-000000000002';

const db = new PrismaClient();
const service = new AceitesService(db as unknown as PrismaService);

async function montar() {
  await limparEmpresa(db, EMPRESA);
  const q = (sql: string) => db.$executeRawUnsafe(sql);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','FIT-011','fit-011-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${USUARIO}','fit011@teste.local','x','Aluno FIT-011','aluno','${EMPRESA}',now())`,
  );
}

function codigoDe(erro: unknown): string {
  const r = (erro as { getResponse?: () => unknown }).getResponse?.();
  return (r as { code?: string })?.code ?? String(erro);
}

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('FIT-011 — o termo da plataforma', () => {
  it('a v1 existe no banco, posta pela própria migration', async () => {
    // Sem ela, o portão exigiria uma versão cujo texto não existe e
    // bloquearia todo mundo sem saída — falha fechada no pior sentido.
    const termo = await db.termoDaPlataforma.findUnique({
      where: { versao: TERMO_VERSAO_VIGENTE },
    });

    expect(termo).not.toBeNull();
    expect(termo?.texto.length).toBeGreaterThan(200);
  });

  it('aluno novo tem o termo pendente, com o texto junto', async () => {
    await montar();

    const pendentes = await service.pendentes(USUARIO);

    expect(pendentes.termo?.versao).toBe(TERMO_VERSAO_VIGENTE);
    // O texto vem na mesma resposta de propósito: uma segunda requisição
    // criaria a janela em que a pessoa lê um texto e aceita outro.
    expect(pendentes.termo?.texto).toContain('TERMO DE USO');
    expect(pendentes.contrato).toBeNull();
  });
});

describe('FIT-011 — o contrato do clube', () => {
  it('empresa sem contrato não gera pendência (REQ-005)', async () => {
    // É o estado de TODA empresa existente no dia da migration.
    await montar();

    expect((await service.pendentes(USUARIO)).contrato).toBeNull();
  });

  it('publicar cria a v1 e aponta a empresa para ela', async () => {
    await montar();

    const publicado = await service.publicarContrato(EMPRESA, '  Contrato A  ');

    expect(publicado.versao).toBe(1);
    // `trim` na entrada: espaço em branco de copiar-e-colar não vira parte
    // do documento.
    expect(publicado.texto).toBe('Contrato A');
    expect(
      (
        await db.empresa.findUniqueOrThrow({
          where: { id: EMPRESA },
          select: { contratoVersaoVigente: true },
        })
      ).contratoVersaoVigente,
    ).toBe(1);
  });

  it('publicar de novo cria a v2 — e a v1 CONTINUA legível (INV-024c)', async () => {
    await montar();
    await service.publicarContrato(EMPRESA, 'Contrato A');
    await service.publicarContrato(EMPRESA, 'Contrato B');

    const v1 = await db.contratoDaEmpresa.findUnique({
      where: { companyId_versao: { companyId: EMPRESA, versao: 1 } },
    });

    // É a diferença entre um registro e uma caixinha booleana: no dia da
    // contestação, alguém precisa poder ler o que foi aceito.
    expect(v1?.texto).toBe('Contrato A');
    expect((await service.contratoVigente(EMPRESA)).texto).toBe('Contrato B');
  });

  it('recusa contrato vazio', async () => {
    await montar();

    await expect(service.publicarContrato(EMPRESA, '   ')).rejects.toThrow();
  });
});

describe('FIT-011 — o aceite', () => {
  it('registra as duas verdades na mesma transação', async () => {
    await montar();
    await service.publicarContrato(EMPRESA, 'Contrato A');

    await service.aceitar(USUARIO, {
      termo: TERMO_VERSAO_VIGENTE,
      contrato: 1,
    });

    // A coluna responde ao portão...
    const usuario = await db.usuario.findUniqueOrThrow({
      where: { id: USUARIO },
      select: { termoVersaoAceita: true, contratoVersaoAceita: true },
    });
    expect(usuario.termoVersaoAceita).toBe(TERMO_VERSAO_VIGENTE);
    expect(usuario.contratoVersaoAceita).toBe(1);

    // ...e a tabela responde ao advogado.
    const registros = await db.aceite.findMany({
      where: { usuarioId: USUARIO },
      orderBy: { tipo: 'asc' },
    });
    expect(registros).toHaveLength(2);
    expect(registros.map((r) => r.tipo).sort()).toEqual(['contrato', 'termo']);
    expect(registros[0].aceitoEm).toBeInstanceOf(Date);
  });

  it('aceitar duas vezes NÃO cria duas linhas (a UNIQUE do banco)', async () => {
    await montar();

    await service.aceitar(USUARIO, { termo: TERMO_VERSAO_VIGENTE });
    await service.aceitar(USUARIO, { termo: TERMO_VERSAO_VIGENTE });

    expect(
      await db.aceite.count({ where: { usuarioId: USUARIO, tipo: 'termo' } }),
    ).toBe(1);
  });

  it('aceitar versão que não é a vigente dá VERSAO_DESATUALIZADA', async () => {
    // A pessoa leu a v1 e a v2 foi publicada no meio. Aceitar assim mesmo
    // registraria concordância com um texto que ela não viu.
    await montar();
    await service.publicarContrato(EMPRESA, 'Contrato A');
    await service.publicarContrato(EMPRESA, 'Contrato B');

    await expect(
      service.aceitar(USUARIO, { contrato: 1 }).catch((e: unknown) => {
        throw new Error(codigoDe(e));
      }),
    ).rejects.toThrow('VERSAO_DESATUALIZADA');
  });

  it('contrato novo devolve a pessoa à pendência — e o aceite antigo fica', async () => {
    await montar();
    await service.publicarContrato(EMPRESA, 'Contrato A');
    await service.aceitar(USUARIO, {
      termo: TERMO_VERSAO_VIGENTE,
      contrato: 1,
    });

    await service.publicarContrato(EMPRESA, 'Contrato B');
    const pendentes = await service.pendentes(USUARIO);

    expect(pendentes.termo).toBeNull();
    expect(pendentes.contrato?.versao).toBe(2);
    // INV-024a: nada é apagado. O aceite da v1 continua sendo verdade sobre
    // o passado, mesmo depois de a v2 existir.
    expect(
      await db.aceite.count({
        where: { usuarioId: USUARIO, tipo: 'contrato', versao: 1 },
      }),
    ).toBe(1);
  });

  it('corpo vazio é engano de chamada, não "não mude nada"', async () => {
    await montar();

    await expect(service.aceitar(USUARIO, {})).rejects.toThrow();
  });
});
