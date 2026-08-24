/**
 * SPEC-017/TASK-004 — o ensaio das constraints da fila de exclusão.
 *
 * **Precisa de Postgres de verdade** (`pnpm test:banco`). Mock não tem
 * CHECK, não tem UNIQUE e não tem tipo: uma suíte com Prisma mockado
 * passaria com a tabela inexistente, e é por isso que a regra de camada do
 * projeto diz que invariante crítica é constraint de banco, não `if` de
 * aplicação.
 *
 * A regra do projeto é "o ensaio de migration tenta violar cada constraint
 * antes de aplicar". Este arquivo é esse ensaio, virado suíte: cada teste
 * **tenta escrever o estado proibido** e exige que o banco recuse. Teste
 * que só grava o caso feliz não prova constraint nenhuma — prova que a
 * tabela existe.
 */
import { PrismaClient } from '@prisma/client';

jest.setTimeout(60_000);

const prisma = new PrismaClient();

const EMPRESA_A = '11111111-1111-4111-8111-111111111111';
const EMPRESA_B = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(64);

function chave(companyId: string, sufixo = SHA): string {
  return `empresas/${companyId}/quadra/quadra-9/${sufixo}.webp`;
}

/** Insere por SQL cru: o Prisma Client não deixa montar estado inválido. */
async function inserir(campos: Record<string, unknown>): Promise<void> {
  const linha = {
    id: crypto.randomUUID(),
    key: chave(EMPRESA_A),
    company_id: EMPRESA_A,
    motivo: 'quadra trocou de imagem',
    tentativas: 0,
    ultimo_erro: null,
    lock_skip_count: 0,
    last_lock_conflict_at: null,
    ...campos,
  };
  await prisma.$executeRawUnsafe(
    `INSERT INTO arquivos_pendentes_exclusao
       (id, key, company_id, motivo, tentativas, ultimo_erro,
        lock_skip_count, last_lock_conflict_at)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8::timestamp)`,
    linha.id,
    linha.key,
    linha.company_id,
    linha.motivo,
    linha.tentativas,
    linha.ultimo_erro,
    linha.lock_skip_count,
    linha.last_lock_conflict_at,
  );
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe('DELETE FROM arquivos_pendentes_exclusao');
});

afterAll(async () => {
  await prisma.$executeRawUnsafe('DELETE FROM arquivos_pendentes_exclusao');
  await prisma.$disconnect();
});

describe('arquivos_pendentes_exclusao — o caso feliz', () => {
  it('aceita a linha que a TASK-005 vai gravar', async () => {
    await inserir({});
    const linhas = await prisma.arquivoPendenteExclusao.findMany();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      companyId: EMPRESA_A,
      tentativas: 0,
      ultimoErro: null,
      lockSkipCount: 0,
      lastLockConflictAt: null,
    });
    // `criado_em` é a base da carência de 1 h (AC-016b): tem de vir do
    // banco, não de quem insere.
    expect(linhas[0].criadoEm).toBeInstanceOf(Date);
  });

  it('aceita item já falhado, com erro e tentativas', async () => {
    await inserir({ tentativas: 3, ultimo_erro: 'AccessDenied' });
    const [linha] = await prisma.arquivoPendenteExclusao.findMany();
    expect(linha.tentativas).toBe(3);
    expect(linha.ultimoErro).toBe('AccessDenied');
  });

  it('aceita item reagendado por lock, com o contador PRÓPRIO', async () => {
    // AC-016d: concorrência normal não é erro. `tentativas` fica em 0.
    await inserir({
      lock_skip_count: 4,
      last_lock_conflict_at: new Date().toISOString(),
    });
    const [linha] = await prisma.arquivoPendenteExclusao.findMany();
    expect(linha.lockSkipCount).toBe(4);
    expect(linha.tentativas).toBe(0);
    expect(linha.ultimoErro).toBeNull();
  });
});

describe('INV-030 — o banco recusa chave fora da empresa', () => {
  it('recusa company_id que não bate com o prefixo da chave', async () => {
    // O cenário que a AC-018 chama de "chave adulterada no banco", visto do
    // lado da escrita: se passasse, o teto por empresa (AC-016c) pararia a
    // empresa errada e deixaria a certa esvaziar.
    await expect(
      inserir({ key: chave(EMPRESA_B), company_id: EMPRESA_A }),
    ).rejects.toThrow(/arquivos_pendentes_key_da_empresa_check/);
  });

  it('recusa chave que não começa por empresas/', async () => {
    await expect(
      inserir({ key: `outra-coisa/${EMPRESA_A}/x/${SHA}.webp` }),
    ).rejects.toThrow(/arquivos_pendentes_key_da_empresa_check/);
  });

  it('recusa chave vazia', async () => {
    await expect(inserir({ key: '' })).rejects.toThrow(
      /arquivos_pendentes_key_da_empresa_check/,
    );
  });
});

describe('a mesma chave não entra duas vezes', () => {
  it('recusa duplicata — carência e teto contariam o mesmo arquivo duas vezes', async () => {
    await inserir({});
    // O Prisma não repassa o nome do índice num 23505, só a chave duplicada
    // — daí a asserção ser pelo código do Postgres e pela coluna.
    await expect(inserir({})).rejects.toThrow(/23505.*Key \(key\)/s);
  });

  it('mas duas chaves diferentes da mesma empresa convivem', async () => {
    await inserir({});
    await inserir({ key: chave(EMPRESA_A, 'b'.repeat(64)) });
    expect(await prisma.arquivoPendenteExclusao.count()).toBe(2);
  });
});

describe('contadores', () => {
  it.each([
    ['tentativas', { tentativas: -1 }],
    ['lock_skip_count', { lock_skip_count: -1 }],
  ])('recusa %s negativo', async (_rotulo, campos) => {
    // Contador negativo faria o item nunca chegar às 5 falhas da AC-016:
    // ficaria na fila para sempre, sem nunca sinalizar.
    await expect(inserir(campos)).rejects.toThrow(
      /arquivos_pendentes_contadores_check/,
    );
  });
});

describe('afirmação sem lastro', () => {
  it('recusa ultimo_erro sem nenhuma tentativa', async () => {
    await expect(
      inserir({ tentativas: 0, ultimo_erro: 'AccessDenied' }),
    ).rejects.toThrow(/arquivos_pendentes_erro_com_tentativa_check/);
  });

  it('recusa conflito de lock datado com contador zerado', async () => {
    await expect(
      inserir({
        lock_skip_count: 0,
        last_lock_conflict_at: new Date().toISOString(),
      }),
    ).rejects.toThrow(/arquivos_pendentes_lock_com_conflito_check/);
  });

  it('recusa contador de lock sem data do conflito', async () => {
    await expect(
      inserir({ lock_skip_count: 2, last_lock_conflict_at: null }),
    ).rejects.toThrow(/arquivos_pendentes_lock_com_conflito_check/);
  });

  it.each([[''], ['   ']])('recusa motivo em branco (%p)', async (motivo) => {
    // A coluna existe para o alerta dizer POR QUE aquele arquivo ia sumir.
    await expect(inserir({ motivo })).rejects.toThrow(
      /arquivos_pendentes_motivo_nao_vazio_check/,
    );
  });
});

describe('a fila sobrevive à empresa', () => {
  it('não tem FK para empresas — company_id inexistente é aceito', async () => {
    // É a única tabela do schema assim, e é decisão, não esquecimento:
    // apagar a empresa é exatamente quando há MAIS objeto para apagar.
    // RESTRICT impediria apagar a empresa; CASCADE apagaria a fila e
    // deixaria o arquivo órfão no bucket para sempre.
    const fantasma = '99999999-9999-4999-8999-999999999999';
    await inserir({ key: chave(fantasma), company_id: fantasma });
    expect(await prisma.arquivoPendenteExclusao.count()).toBe(1);
  });
});
