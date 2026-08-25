/**
 * FIT-006 — SPEC-017/TASK-007. **Contra o bucket real.**
 *
 * O resto da SPEC-017 é provado por unitário, e2e e Postgres real. Esta
 * suíte existe para as provas que **nenhum dublê consegue dar**: ACL por
 * arquivo, CDN, assinatura que expira, e "1 objeto" — que é uma pergunta
 * sobre o bucket, não sobre o nosso código.
 *
 * Não roda no CI: exige credencial. É opt-in, e a trava explica como.
 *
 *   set -a; . ./.env; set +a; pnpm run test:bucket
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { S3StorageProvider } from '../../src/storage/s3-storage.provider';
import { montarChave } from '../../src/storage/chave-de-midia';
import { FalhaDeStorage } from '../../src/storage/storage-provider.interface';
import {
  CACHE_CONTROL_PRIVADO,
  CACHE_CONTROL_PUBLICO,
  TETO_EXPIRACAO_URL_ASSINADA_SEGUNDOS,
} from '../../src/storage/storage.config';
import { validarWebp } from '../../src/storage/webp.validator';
import {
  EMPRESA_DE_TESTE,
  exigirBucketDeTeste,
  PREFIXO_DE_TESTE,
} from './exigir-bucket-de-teste';

jest.setTimeout(180_000);

const config = exigirBucketDeTeste();
const provider = new S3StorageProvider(config);

const RECURSO = 'c3d4e5f6-33ef-4333-8333-3f3e3d3c3b3a';
const CORPUS = join(__dirname, '..', 'fixtures', 'webp');

function conteudo(nome: string): Buffer {
  return readFileSync(join(CORPUS, nome));
}

function chaveDe(corpo: Buffer, tipo: 'quadra' | 'perfil'): string {
  const sha256 = createHash('sha256').update(corpo).digest('hex');
  const key = montarChave({
    companyId: EMPRESA_DE_TESTE,
    tipo,
    recursoId: RECURSO,
    sha256,
  });
  if (key === null) {
    throw new Error('a gramática recusou a chave da própria suíte');
  }
  return key;
}

const criadas = new Set<string>();

async function subir(nome: string, tipo: 'quadra' | 'perfil'): Promise<string> {
  const corpo = conteudo(nome);
  const key = chaveDe(corpo, tipo);
  await provider.gravar({
    key,
    corpo,
    contentType: 'image/webp',
    visibilidade: tipo === 'quadra' ? 'publico' : 'privado',
  });
  criadas.add(key);
  return key;
}

async function esperar(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

afterAll(async () => {
  // Apaga SÓ o que esta suíte criou, uma chave por vez. Não há varredura
  // por prefixo nem `DELETE` largo — ver a trava.
  for (const key of criadas) {
    await provider.apagar(key);
  }
});

describe('FIT-006 — o bucket é real', () => {
  it('a suíte só toca no próprio prefixo', () => {
    // A primeira prova é sobre a própria suíte: se ela puder escrever fora
    // daqui, nenhuma das outras importa.
    const key = chaveDe(conteudo('valido-vp8-lossy.webp'), 'quadra');
    expect(key.startsWith(PREFIXO_DE_TESTE)).toBe(true);
    expect(config.bucket).toBe('playck-media');
  });

  describe('AC-009 — objeto público abre em aba anônima', () => {
    it('GET sem nenhuma credencial devolve 200 pelo CDN', async () => {
      const key = await subir('valido-vp8-lossy.webp', 'quadra');

      const resposta = await fetch(provider.urlPublica(key));

      expect(resposta.status).toBe(200);
      expect(resposta.headers.get('cache-control')).toBe(CACHE_CONTROL_PUBLICO);
      expect(resposta.headers.get('content-type')).toBe('image/webp');
    });

    it('e o que voltou é byte a byte o que subiu', async () => {
      // Prova que o `PUT` não transformou o corpo — o que importa porque o
      // validador aprovou aqueles bytes, e não outros.
      const original = conteudo('valido-vp8l-lossless.webp');
      const key = await subir('valido-vp8l-lossless.webp', 'quadra');

      const baixado = Buffer.from(
        await (await fetch(provider.urlPublica(key))).arrayBuffer(),
      );

      expect(baixado.equals(original)).toBe(true);
      expect(validarWebp(baixado).valido).toBe(true);
    });
  });

  describe('AC-010/REQ-003 — o privado é privado', () => {
    it('GET anônimo no objeto privado é NEGADO', async () => {
      const key = await subir('valido-vp8x-com-alpha.webp', 'perfil');

      const anonimo = await fetch(provider.urlPublica(key));

      expect(anonimo.status).toBe(403);
    });

    it('com URL assinada, 200 — e a assinatura declara 15 min', async () => {
      const key = await subir('valido-vp8x-com-alpha.webp', 'perfil');

      const assinada = await provider.urlAssinada(key);
      const comAssinatura = await fetch(assinada);

      expect(comAssinatura.status).toBe(200);
      expect(comAssinatura.headers.get('cache-control')).toBe(
        CACHE_CONTROL_PRIVADO,
      );
      expect(new URL(assinada).searchParams.get('X-Amz-Expires')).toBe(
        String(TETO_EXPIRACAO_URL_ASSINADA_SEGUNDOS),
      );
    });

    it('a assinatura EXPIRA de verdade — o Spaces recusa depois do prazo', async () => {
      // A prova que faltava. Esperar 15 minutos seria inviável, então a URL
      // é assinada com o menor prazo possível — o teto da AC-010 é máximo,
      // não valor fixo. Quem verifica o prazo é o Spaces, não nós.
      const key = await subir('valido-vp8x-com-alpha.webp', 'perfil');

      // 5 s, e não 1: assinar e buscar já leva quase um segundo, e a
      // primeira tentativa precisa acontecer DENTRO do prazo — senão o
      // teste passaria por chegar atrasado, provando o oposto do que diz.
      const curta = await provider.urlAssinada(key, 5);
      expect((await fetch(curta)).status).toBe(200);

      await esperar(9000);

      expect((await fetch(curta)).status).toBe(403);
    });
  });

  describe('AC-007/AC-008 — a chave é o conteúdo', () => {
    it('o mesmo arquivo enviado 3x deixa UM objeto', async () => {
      // É uma pergunta sobre o bucket, não sobre o nosso código: só listando
      // dá para saber que não houve duplicata. Com UUID no lugar do sha,
      // seriam três.
      const chaves = new Set<string>();
      for (let i = 0; i < 3; i++) {
        chaves.add(await subir('valido-2500px-no-limite.webp', 'quadra'));
      }
      expect(chaves.size).toBe(1);

      const key = [...chaves][0];
      const meta = await provider.metadados(key);
      expect(meta).not.toBeNull();
      expect(meta?.tamanhoBytes).toBe(
        conteudo('valido-2500px-no-limite.webp').length,
      );
    });

    it('reenviar mantém o `Cache-Control` correto (3ª rodada de validação)', async () => {
      const key = await subir('valido-vp8-lossy.webp', 'quadra');
      await subir('valido-vp8-lossy.webp', 'quadra');

      expect((await provider.metadados(key))?.cacheControl).toBe(
        CACHE_CONTROL_PUBLICO,
      );
    });
  });

  describe('apagar', () => {
    it('apaga, e o objeto some de verdade', async () => {
      const key = await subir('valido-vp8-lossy.webp', 'quadra');
      expect(await provider.metadados(key)).not.toBeNull();

      await provider.apagar(key);
      criadas.delete(key);

      expect(await provider.metadados(key)).toBeNull();
    });

    it('apagar o que não existe NÃO é erro — o worker depende disso', async () => {
      // O worker pode chegar depois de outra réplica ter apagado. Se isso
      // fosse erro, ele contaria tentativa falha por trabalho já feito.
      const key = chaveDe(Buffer.from('nunca-subiu'), 'quadra');
      await expect(provider.apagar(key)).resolves.toBeUndefined();
    });
  });

  describe('NFR-004/TASK-006 — medir o bucket', () => {
    it('mede o uso real e diz que a medição foi completa', async () => {
      await subir('valido-vp8-lossy.webp', 'quadra');

      const uso = await provider.medirUso(200);

      expect(uso.completo).toBe(true);
      expect(uso.objetos).toBeGreaterThan(0);
      expect(uso.bytes).toBeGreaterThan(0);
    });
  });

  describe('a credencial é Limited Access — e isso tem consequência', () => {
    it('assinar chave inexistente não falha; o 404 vem na leitura', async () => {
      // Assinar é cálculo local: o Spaces só é consultado quando alguém
      // abre a URL. É por isso que a recusa de chave adulterada tem de
      // acontecer ANTES, no `StorageService` (INV-037) — o storage não vai
      // recusar por nós.
      const key = chaveDe(Buffer.from('inexistente'), 'perfil');

      const url = await provider.urlAssinada(key);
      expect(url).toContain('X-Amz-Signature');

      expect((await fetch(url)).status).toBe(404);
    });

    it('erro do storage vira FalhaDeStorage, com a chave', async () => {
      const provedorComBucketErrado = new S3StorageProvider({
        ...config,
        bucket: 'playck-media-que-nao-existe',
      });

      const erro = await provedorComBucketErrado
        .gravar({
          key: chaveDe(Buffer.from('x'), 'quadra'),
          corpo: Buffer.from('x'),
          contentType: 'image/webp',
          visibilidade: 'publico',
        })
        .catch((e: unknown) => e);

      expect(erro).toBeInstanceOf(FalhaDeStorage);
      expect((erro as FalhaDeStorage).operacao).toBe('gravar');
    });
  });
});
