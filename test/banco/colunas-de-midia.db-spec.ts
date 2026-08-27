/**
 * SPEC-018/TASK-001 — o ensaio das constraints das seis colunas de mídia.
 *
 * **Precisa de Postgres de verdade** (`pnpm test:banco`). Prisma mockado não
 * tem CHECK nem FK: uma suíte mockada passaria com a coluna inexistente.
 *
 * A regra do projeto é "o ensaio de migration tenta violar cada constraint".
 * Cada teste aqui **tenta gravar o estado proibido** e exige recusa do banco.
 * O caso feliz aparece uma vez, para provar que a coluna aceita o que a
 * TASK-003 vai escrever — o resto é violação.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(60_000);

// Antes de qualquer conexão: esta suíte escreve.
exigirBancoLocal();

const prisma = new PrismaClient();

const EMPRESA_A = '11111111-1111-4111-8111-111000180001';
const EMPRESA_B = '22222222-2222-4222-8222-222000180002';
const ADMIN_A = '33333333-3333-4333-8333-333000180003';
const SUPER = '44444444-4444-4444-8444-444000180004';
const QUADRA_A = '55555555-5555-4555-8555-555000180005';
const PROF_A = '66666666-6666-4666-8666-666000180006';
const SHA = 'a'.repeat(64);

/** Chave que o parser da SPEC-017 (`chave-de-midia.ts`) aceitaria. */
function chave(companyId: string, tipo: string, recurso: string): string {
  return `empresas/${companyId}/${tipo}/${recurso}/${SHA}.webp`;
}

const sql = (texto: string, ...valores: unknown[]) =>
  prisma.$executeRawUnsafe(texto, ...valores);

async function semear(): Promise<void> {
  const empresas: [string, string, string][] = [
    [EMPRESA_A, 'Empresa A 018', 'empresa-a-018'],
    [EMPRESA_B, 'Empresa B 018', 'empresa-b-018'],
  ];
  for (const [id, nome, slug] of empresas) {
    await sql(
      // SPEC-020/TASK-004 — `empresas.esportes` não existe mais. A lista de
      // esportes da empresa é o catálogo (INV-057).
      `INSERT INTO empresas (id, nome, slug, status, updated_at)
       VALUES ($1::uuid, $2, $3, 'ativa', now())`,
      id,
      nome,
      slug,
    );
  }

  await sql(
    `INSERT INTO usuarios (id, email, senha_hash, nome, role, company_id, updated_at)
     VALUES ($1::uuid, 'admin-018@teste.local', 'x', 'Admin 018',
             'company_admin', $2::uuid, now())`,
    ADMIN_A,
    EMPRESA_A,
  );

  // `super_admin` tem `company_id` NULL — imposto por
  // `usuarios_company_id_role_check`, que já existia.
  await sql(
    `INSERT INTO usuarios (id, email, senha_hash, nome, role, company_id, updated_at)
     VALUES ($1::uuid, 'super-018@teste.local', 'x', 'Super 018',
             'super_admin', NULL, now())`,
    SUPER,
  );

  await sql(
    `-- SPEC-020/TASK-004 — quadra sem esporte deixou de existir. A opcao vem
     -- antes, e precisa ser da MESMA empresa (a FK e composta).
     INSERT INTO esportes_de_quadra (id, company_id, nome, ordem, created_at)
     SELECT gen_random_uuid(), $1::uuid, 'Tenis', 0, now()
     WHERE NOT EXISTS (
       SELECT 1 FROM esportes_de_quadra WHERE company_id = $1::uuid AND nome = 'Tenis'
     )`,
    EMPRESA_A,
  );

  await sql(
    `INSERT INTO quadras (id, company_id, nome, esporte_id, preco_hora, status)
     VALUES ($1::uuid, $2::uuid, 'Quadra 018',
             (SELECT id FROM esportes_de_quadra WHERE company_id = $2::uuid AND nome = 'Tenis'),
             100.00, 'ativa')`,
    QUADRA_A,
    EMPRESA_A,
  );

  await sql(
    `INSERT INTO professores (id, company_id, nome, status)
     VALUES ($1::uuid, $2::uuid, 'Professor sem conta 018', 'ativo')`,
    PROF_A,
    EMPRESA_A,
  );
}

beforeAll(async () => {
  await limparEmpresa(prisma, EMPRESA_A);
  await limparEmpresa(prisma, EMPRESA_B);
  await sql(`DELETE FROM usuarios WHERE id = $1::uuid`, SUPER);
  await semear();
});

afterAll(async () => {
  await limparEmpresa(prisma, EMPRESA_A);
  await limparEmpresa(prisma, EMPRESA_B);
  await sql(`DELETE FROM usuarios WHERE id = $1::uuid`, SUPER);
  await prisma.$disconnect();
});

/** Estado limpo entre testes: as seis colunas voltam a NULL. */
beforeEach(async () => {
  await sql(
    `UPDATE quadras SET imagem_key = NULL, imagem_confirmada_por = NULL,
       imagem_confirmada_em = NULL WHERE id = $1::uuid`,
    QUADRA_A,
  );
  await sql(`UPDATE usuarios SET foto_key = NULL WHERE id = $1::uuid`, ADMIN_A);
  await sql(
    `UPDATE professores SET foto_key = NULL WHERE id = $1::uuid`,
    PROF_A,
  );
  await sql(
    `UPDATE empresas SET logo_key = NULL WHERE id = $1::uuid`,
    EMPRESA_A,
  );
});

describe('o caso feliz — as seis colunas aceitam o que a SPEC-018 vai gravar', () => {
  it('grava foto de perfil, foto de professor, imagem de quadra e logo', async () => {
    await sql(
      `UPDATE usuarios SET foto_key = $2 WHERE id = $1::uuid`,
      ADMIN_A,
      chave(EMPRESA_A, 'perfil', ADMIN_A),
    );
    await sql(
      `UPDATE professores SET foto_key = $2 WHERE id = $1::uuid`,
      PROF_A,
      chave(EMPRESA_A, 'professor', PROF_A),
    );
    await sql(
      `UPDATE empresas SET logo_key = $2 WHERE id = $1::uuid`,
      EMPRESA_A,
      chave(EMPRESA_A, 'logo', EMPRESA_A),
    );
    await sql(
      `UPDATE quadras SET imagem_key = $2, imagem_confirmada_por = $3::uuid,
         imagem_confirmada_em = now() WHERE id = $1::uuid`,
      QUADRA_A,
      chave(EMPRESA_A, 'quadra', QUADRA_A),
      ADMIN_A,
    );

    const quadra = await prisma.quadra.findUniqueOrThrow({
      where: { id: QUADRA_A },
    });
    expect(quadra.imagemKey).toBe(chave(EMPRESA_A, 'quadra', QUADRA_A));
    expect(quadra.imagemConfirmadaPor).toBe(ADMIN_A);
    expect(quadra.imagemConfirmadaEm).toBeInstanceOf(Date);

    const usuario = await prisma.usuario.findUniqueOrThrow({
      where: { id: ADMIN_A },
    });
    expect(usuario.fotoKey).toBe(chave(EMPRESA_A, 'perfil', ADMIN_A));

    const professor = await prisma.professor.findUniqueOrThrow({
      where: { id: PROF_A },
    });
    expect(professor.fotoKey).toBe(chave(EMPRESA_A, 'professor', PROF_A));

    const empresa = await prisma.empresa.findUniqueOrThrow({
      where: { id: EMPRESA_A },
    });
    expect(empresa.logoKey).toBe(chave(EMPRESA_A, 'logo', EMPRESA_A));
  });

  it('todas nascem NULL — a migration é expand puro, sem backfill', async () => {
    const quadra = await prisma.quadra.findUniqueOrThrow({
      where: { id: QUADRA_A },
    });
    expect(quadra.imagemKey).toBeNull();
    expect(quadra.imagemConfirmadaPor).toBeNull();
    expect(quadra.imagemConfirmadaEm).toBeNull();

    const empresa = await prisma.empresa.findUniqueOrThrow({
      where: { id: EMPRESA_A },
    });
    expect(empresa.logoKey).toBeNull();
    // `logo_url` continua intacta — AC-012/013, sem migração.
    expect(empresa.logoUrl).toBeNull();
  });
});

describe('AC-008 — imagem de quadra e confirmação vivem e morrem juntas', () => {
  it('recusa imagem SEM confirmação — é a AC-007 imposta pelo banco', async () => {
    // Sem isto, a exigência da AC-007 seria só do controller, e a decisão 1
    // vira aviso de tela: qualquer caminho novo que esquecesse o campo
    // gravaria imagem pública sem ninguém ter garantido nada.
    await expect(
      sql(
        `UPDATE quadras SET imagem_key = $2 WHERE id = $1::uuid`,
        QUADRA_A,
        chave(EMPRESA_A, 'quadra', QUADRA_A),
      ),
    ).rejects.toThrow(/quadras_imagem_confirmada_check/);
  });

  it('recusa imagem com autor mas sem data', async () => {
    await expect(
      sql(
        `UPDATE quadras SET imagem_key = $2, imagem_confirmada_por = $3::uuid
         WHERE id = $1::uuid`,
        QUADRA_A,
        chave(EMPRESA_A, 'quadra', QUADRA_A),
        ADMIN_A,
      ),
    ).rejects.toThrow(/quadras_imagem_confirmada_check/);
  });

  it('recusa confirmação órfã, sem imagem nenhuma', async () => {
    await expect(
      sql(
        `UPDATE quadras SET imagem_confirmada_por = $2::uuid,
           imagem_confirmada_em = now() WHERE id = $1::uuid`,
        QUADRA_A,
        ADMIN_A,
      ),
    ).rejects.toThrow(/quadras_imagem_confirmada_check/);
  });

  it('recusa apagar SÓ a imagem, deixando a confirmação para trás', async () => {
    await sql(
      `UPDATE quadras SET imagem_key = $2, imagem_confirmada_por = $3::uuid,
         imagem_confirmada_em = now() WHERE id = $1::uuid`,
      QUADRA_A,
      chave(EMPRESA_A, 'quadra', QUADRA_A),
      ADMIN_A,
    );
    // AC-010, "remover sem substituir": a ação de apagar tem de zerar as
    // três. Zerar só a chave deixaria confirmação apontando para imagem que
    // não existe mais.
    await expect(
      sql(`UPDATE quadras SET imagem_key = NULL WHERE id = $1::uuid`, QUADRA_A),
    ).rejects.toThrow(/quadras_imagem_confirmada_check/);
  });
});

describe('AC-014/INV-030 — chave gravada mora sob a empresa do dono da linha', () => {
  it('recusa imagem de quadra com chave de OUTRA empresa', async () => {
    // O cenário "chave adulterada no banco": prefixo e escopo por token leem
    // o mesmo token e concordariam entre si. Só a comparação com a linha
    // percebe.
    await expect(
      sql(
        `UPDATE quadras SET imagem_key = $2, imagem_confirmada_por = $3::uuid,
           imagem_confirmada_em = now() WHERE id = $1::uuid`,
        QUADRA_A,
        chave(EMPRESA_B, 'quadra', QUADRA_A),
        ADMIN_A,
      ),
    ).rejects.toThrow(/quadras_imagem_da_empresa_check/);
  });

  it('recusa foto de professor com chave de outra empresa', async () => {
    await expect(
      sql(
        `UPDATE professores SET foto_key = $2 WHERE id = $1::uuid`,
        PROF_A,
        chave(EMPRESA_B, 'professor', PROF_A),
      ),
    ).rejects.toThrow(/professores_foto_da_empresa_check/);
  });

  it('recusa logo com chave de outra empresa', async () => {
    await expect(
      sql(
        `UPDATE empresas SET logo_key = $2 WHERE id = $1::uuid`,
        EMPRESA_A,
        chave(EMPRESA_B, 'logo', EMPRESA_A),
      ),
    ).rejects.toThrow(/empresas_logo_da_empresa_check/);
  });

  it('recusa foto de perfil com chave de outra empresa', async () => {
    await expect(
      sql(
        `UPDATE usuarios SET foto_key = $2 WHERE id = $1::uuid`,
        ADMIN_A,
        chave(EMPRESA_B, 'perfil', ADMIN_A),
      ),
    ).rejects.toThrow(/usuarios_foto_da_empresa_check/);
  });

  it('recusa chave que não começa por empresas/', async () => {
    await expect(
      sql(
        `UPDATE usuarios SET foto_key = $2 WHERE id = $1::uuid`,
        ADMIN_A,
        `outra-coisa/${EMPRESA_A}/perfil/${ADMIN_A}/${SHA}.webp`,
      ),
    ).rejects.toThrow(/usuarios_foto_da_empresa_check/);
  });

  it('recusa chave vazia', async () => {
    await expect(
      sql(`UPDATE professores SET foto_key = '' WHERE id = $1::uuid`, PROF_A),
    ).rejects.toThrow(/professores_foto_da_empresa_check/);
  });
});

describe('o super_admin não tem foto — e é o banco que diz isso', () => {
  it('recusa foto_key em usuário sem empresa', async () => {
    // A gramática da chave (INV-035) começa por `empresas/<company_id>/` e
    // NÃO TEM COMO representar foto de quem não pertence a empresa nenhuma.
    // O CHECK torna isso explícito, em vez de deixar o caminho aberto para
    // uma chave malformada que só o parser recusaria depois — na leitura,
    // com o objeto já no bucket.
    //
    // **É decisão de produto pendente**, registrada como pergunta aberta da
    // TASK-003: o contrato diz `PUT /api/v1/me/foto` para "qualquer
    // autenticado", e `super_admin` é autenticado.
    await expect(
      sql(
        `UPDATE usuarios SET foto_key = $2 WHERE id = $1::uuid`,
        SUPER,
        chave(EMPRESA_A, 'perfil', SUPER),
      ),
    ).rejects.toThrow(/usuarios_foto_da_empresa_check/);
  });
});

describe('a confirmação vale por ter nome de gente', () => {
  it('recusa apagar o usuário que confirmou uma imagem (Restrict)', async () => {
    await sql(
      `UPDATE quadras SET imagem_key = $2, imagem_confirmada_por = $3::uuid,
         imagem_confirmada_em = now() WHERE id = $1::uuid`,
      QUADRA_A,
      chave(EMPRESA_A, 'quadra', QUADRA_A),
      ADMIN_A,
    );
    // `SetNull` apagaria o autor e deixaria a imagem pública no ar sem quem
    // respondesse por ela — o estado que a decisão 1 existe para não
    // permitir. Mesmo regime de `chamadas.registrada_por`.
    await expect(
      sql(`DELETE FROM usuarios WHERE id = $1::uuid`, ADMIN_A),
    ).rejects.toThrow(/quadras_imagem_confirmada_por_fkey/);
  });
});
