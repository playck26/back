/**
 * SPEC-018/TASK-007 — o checker REAL contra Postgres real.
 *
 * **Por que esta suíte existe, tendo unitário.** Os testes unitários provam
 * a lógica do checker com um Prisma dublê; os de banco do worker
 * (`fila-worker.db-spec.ts`) provam o worker com um checker **falso**
 * (`() => Promise.resolve(false)`). Entre os dois havia um vão: ninguém
 * provava que o checker de verdade, lendo as colunas de verdade, responde
 * certo.
 *
 * E é justamente o vão onde mora o erro caro. Um `where` com o campo errado,
 * um delegate trocado (`usuario` no lugar de `professor`), um `count` que
 * consulta a tabela certa e a coluna errada — nada disso o dublê pega,
 * porque o dublê responde o que o teste mandou.
 *
 * **O que este arquivo prova é a AC-016 inteira:** com o checker real
 * registrado, o worker apaga o que ninguém referencia e **não** apaga o que
 * alguém referencia.
 */
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { CheckerDeReferencia } from '../../src/storage/checker-de-referencia.service';
import { KeyReferenceRegistry } from '../../src/storage/key-reference-checker';
import { AlertaDeStorage } from '../../src/storage/alerta-de-storage';
import type { StorageProvider } from '../../src/storage/storage-provider.interface';
import { WorkerDeExclusao } from '../../src/storage/worker-de-exclusao.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(120_000);

// Antes de qualquer conexão: esta suíte escreve.
exigirBancoLocal();

const prisma = new PrismaClient();

const EMPRESA = 'c7c7c7c7-77ef-4777-8777-7f7e7d7c7b7a';
const USUARIO = 'd8d8d8d8-88ef-4888-8888-8f8e8d8c8b8a';
const PROFESSOR = 'e9e9e9e9-99ef-4999-8999-9f9e9d9c9b9a';
const QUADRA = 'fafafafa-aaef-4aaa-8aaa-afaeadacaba0';

const sha = (rotulo: string) =>
  createHash('sha256').update(rotulo).digest('hex');

const chave = (tipo: string, recurso: string, rotulo: string) =>
  `empresas/${EMPRESA}/${tipo}/${recurso}/${sha(rotulo)}.webp`;

const KEY_PERFIL = chave('perfil', USUARIO, 'perfil');
const KEY_PROFESSOR = chave('professor', PROFESSOR, 'professor');
const KEY_QUADRA = chave('quadra', QUADRA, 'quadra');
const KEY_LOGO = chave('logo', EMPRESA, 'logo');
const KEY_ORFA = chave('quadra', QUADRA, 'ninguem-aponta-para-esta');

class AlertaEspiao extends AlertaDeStorage {
  // Silencioso de proposito: esta suite e sobre o CHECKER, e os alertas do
  // worker ja tem prova propria em `fila-worker.db-spec.ts`.
  disparar(): void {}
}

async function semearTudo(): Promise<void> {
  await prisma.empresa.create({
    data: {
      id: EMPRESA,
      nome: 'Harness Checker',
      slug: 'harness-checker-007',
      status: 'ativa',
      logoKey: KEY_LOGO,
    },
  });
  await prisma.usuario.create({
    data: {
      id: USUARIO,
      companyId: EMPRESA,
      nome: 'Pessoa',
      email: 'checker-007@harness.local',
      senhaHash: 'x',
      role: 'company_admin',
      status: 'ativo',
      fotoKey: KEY_PERFIL,
    },
  });
  await prisma.professor.create({
    data: {
      id: PROFESSOR,
      companyId: EMPRESA,
      nome: 'Professor',
      fotoKey: KEY_PROFESSOR,
    },
  });
  // SPEC-020/TASK-004 — quadra sem esporte deixou de existir: `esporte_id` é
  // `NOT NULL` e a FK composta exige que o esporte seja da própria empresa.
  const esporte = await prisma.esporteDeQuadra.create({
    data: { companyId: EMPRESA, nome: 'Tênis', ordem: 0 },
  });
  await prisma.quadra.create({
    data: {
      id: QUADRA,
      companyId: EMPRESA,
      nome: 'Quadra',
      esporteId: esporte.id,
      precoHora: 100,
      status: 'ativa',
      imagemKey: KEY_QUADRA,
      imagemConfirmadaPor: USUARIO,
      imagemConfirmadaEm: new Date(),
    },
  });
}

describe('CheckerDeReferencia contra Postgres real', () => {
  let registry: KeyReferenceRegistry;
  let checker: CheckerDeReferencia;

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'DELETE FROM arquivos_pendentes_exclusao WHERE company_id = $1::uuid',
      EMPRESA,
    );
    await limparEmpresa(prisma, EMPRESA);
    await prisma.empresa.deleteMany({ where: { id: EMPRESA } });
    await semearTudo();

    registry = new KeyReferenceRegistry();
    checker = new CheckerDeReferencia(
      prisma as unknown as PrismaService,
      registry,
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'DELETE FROM arquivos_pendentes_exclusao WHERE company_id = $1::uuid',
      EMPRESA,
    );
    await limparEmpresa(prisma, EMPRESA);
    await prisma.empresa.deleteMany({ where: { id: EMPRESA } });
    await prisma.$disconnect();
  });

  describe('AC-015 — cada coluna, contra o banco de verdade', () => {
    // Tabela e não quatro testes copiados: o que muda entre eles é só a
    // chave, e escrever quatro blocos convidaria a esquecer um quando
    // aparecer a quinta coluna.
    it.each([
      ['usuarios.foto_key', () => KEY_PERFIL],
      ['professores.foto_key', () => KEY_PROFESSOR],
      ['quadras.imagem_key', () => KEY_QUADRA],
      ['empresas.logo_key', () => KEY_LOGO],
    ])('%s apontando: referenciada', async (_nome, obterChave) => {
      await expect(checker.estaReferenciada(obterChave())).resolves.toBe(true);
    });

    it('chave que ninguém aponta: NÃO referenciada', async () => {
      // O caso que autoriza apagar. Se este devolvesse `true`, o worker
      // nunca apagaria nada e o bucket cresceria para sempre — sem erro
      // nenhum aparecendo.
      await expect(checker.estaReferenciada(KEY_ORFA)).resolves.toBe(false);
    });

    it('a resposta é pela chave EXATA — prefixo não conta', async () => {
      // Chave nova do mesmo recurso compartilha todo o prefixo com a antiga.
      // Um `startsWith` faria a nova "proteger" a antiga, e a antiga nunca
      // seria apagada.
      const prefixo = KEY_QUADRA.slice(0, KEY_QUADRA.lastIndexOf('/') + 1);
      await expect(checker.estaReferenciada(prefixo)).resolves.toBe(false);
      await expect(
        checker.estaReferenciada(prefixo + sha('outra') + '.webp'),
      ).resolves.toBe(false);
    });

    it('apagar a referência torna a chave não-referenciada', async () => {
      // O ciclo real: alguém troca a logo, a chave antiga fica órfã, e só
      // então o worker pode apagá-la.
      await expect(checker.estaReferenciada(KEY_LOGO)).resolves.toBe(true);
      await prisma.empresa.update({
        where: { id: EMPRESA },
        data: { logoKey: null },
      });
      await expect(checker.estaReferenciada(KEY_LOGO)).resolves.toBe(false);
    });
  });

  describe('AC-016 — com o checker real, o worker apaga de fato', () => {
    let apagados: string[];
    let worker: WorkerDeExclusao;

    beforeEach(() => {
      apagados = [];
      const provider: StorageProvider = {
        gravar: () => Promise.resolve(),
        apagar: (key) => {
          apagados.push(key);
          return Promise.resolve();
        },
        metadados: () => Promise.resolve(null),
        urlPublica: (k) => k,
        urlAssinada: (k) => Promise.resolve(k),
        medirUso: () =>
          Promise.resolve({ objetos: 0, bytes: 0, completo: true }),
      };
      worker = new WorkerDeExclusao(
        prisma as unknown as PrismaService,
        registry,
        new AlertaEspiao(),
        provider,
      );
      checker.onModuleInit();
    });

    const enfileirar = (key: string) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO arquivos_pendentes_exclusao
           (id, key, company_id, motivo, tentativas, criado_em)
         VALUES (gen_random_uuid(), $1, $2::uuid, 'teste-007', 0,
                 now() - interval '120 minutes')`,
        key,
        EMPRESA,
      );

    it('apaga a chave órfã', async () => {
      await enfileirar(KEY_ORFA);

      await worker.executarCiclo();

      expect(apagados).toEqual([KEY_ORFA]);
    });

    it('NÃO apaga a chave que uma coluna ainda referencia', async () => {
      // O erro que custa caro. A linha entrou na fila (uma troca que foi
      // desfeita, um enfileiramento a mais), e o checker é a única coisa
      // entre ela e a imagem sumindo da tela de alguém.
      await enfileirar(KEY_QUADRA);

      await worker.executarCiclo();

      expect(apagados).toEqual([]);
    });

    it('na mesma fila, apaga só a órfã e poupa as quatro referenciadas', async () => {
      // O teste que um caso isolado não daria: as cinco no mesmo ciclo, e a
      // decisão tomada por chave. Um checker que respondesse pela primeira
      // linha e repetisse a resposta passaria nos dois testes acima.
      for (const k of [
        KEY_PERFIL,
        KEY_PROFESSOR,
        KEY_QUADRA,
        KEY_LOGO,
        KEY_ORFA,
      ]) {
        await enfileirar(k);
      }

      await worker.executarCiclo();

      expect(apagados).toEqual([KEY_ORFA]);
    });
  });
});
