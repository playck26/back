import type { ConfigService } from '@nestjs/config';
import {
  carregarStorageConfig,
  type StorageConfig,
} from '../../src/storage/storage.config';

/**
 * SPEC-017/TASK-007 — a trava do FIT-006.
 *
 * Esta suíte **escreve e apaga objetos no bucket real**. Depois do incidente
 * de 2026-08-24 — em que uma suíte de teste apagou o banco de produção
 * porque ninguém tinha escrito onde ela podia rodar — nenhuma suíte deste
 * projeto toca em recurso real sem dizer, em código, o que aceita tocar.
 *
 * A trava tem três partes, e **as três acontecem antes de qualquer teste
 * rodar**:
 *
 * 1. **Só roda com as 6 variáveis presentes.** Sem elas falha na hora, com a
 *    instrução de como rodar — em vez de conectar em algum lugar por
 *    acidente.
 * 2. **Só roda contra o bucket esperado.** Apontar `SPACES_BUCKET` para
 *    outro lugar com credencial válida derruba o carregamento do módulo.
 * 3. **Só escreve sob um prefixo próprio.** Todo objeto criado vive sob
 *    `empresas/<EMPRESA_DE_TESTE>/`, e a limpeza apaga **chave por chave, só
 *    as que a própria suíte criou**. Não existe varredura por prefixo nem
 *    `DELETE` largo neste diretório.
 *
 * **A parte 2 nasceu da 3ª validação cruzada, e a lição é a mesma do
 * incidente: uma asserção não é uma trava.** A checagem do bucket vivia
 * dentro do primeiro `it`. Com o bucket errado, o Jest marcava aquele teste
 * como falho e **seguia rodando os outros**, que escrevem e apagam. Um teste
 * vermelho não impede o próximo de rodar; só um erro no carregamento do
 * módulo impede.
 *
 * O bucket é compartilhado de fato: `playck-media` passa a guardar mídia de
 * produção na SPEC-018.
 */

/** O único bucket que esta suíte aceita tocar. */
export const BUCKET_ESPERADO = 'playck-media';

/**
 * Empresa fictícia da suíte. **Nenhum dado real vive sob este prefixo**, e é
 * ele que delimita tudo o que o FIT-006 pode criar ou apagar.
 *
 * **Risco declarado (3ª validação cruzada):** o banco gera `uuid_v4`, então
 * nada *por construção* impede uma empresa real de receber este UUID. A
 * probabilidade é desprezível, e a consequência é pequena — a limpeza apaga
 * só as chaves que a suíte criou, então uma colisão deixaria objetos de
 * teste no prefixo daquela empresa, sem apagar mídia dela. Mover o prefixo
 * para fora de `empresas/` foi considerado e recusado: quebraria a gramática
 * de chave (INV-036), que é justamente uma das coisas que o FIT-006 prova.
 */
export const EMPRESA_DE_TESTE = 'f17006f1-7006-4f17-8006-f17006f17006';
export const PREFIXO_DE_TESTE = `empresas/${EMPRESA_DE_TESTE}/`;

/**
 * Recusa qualquer bucket que não seja o esperado. Separada para poder ser
 * testada sem credencial — a trava também precisa de prova.
 */
export function conferirBucketEsperado(bucket: string): void {
  if (bucket !== BUCKET_ESPERADO) {
    throw new Error(
      `FIT-006 escreve e apaga objetos, e só aceita o bucket ` +
        `"${BUCKET_ESPERADO}". SPACES_BUCKET aponta para "${bucket}".\n` +
        'Isto é uma trava, não um aviso: nenhum teste desta suíte roda.',
    );
  }
}

export function exigirBucketDeTeste(): StorageConfig {
  const fake = { get: (nome: string) => process.env[nome] } as ConfigService;
  let config: StorageConfig;
  try {
    config = carregarStorageConfig(fake);
  } catch (causa) {
    throw new Error(
      'FIT-006 precisa das 6 variáveis SPACES_* e fala com o bucket REAL.\n' +
        'Rode assim, de propósito:\n' +
        '  set -a; . ./.env; set +a; pnpm run test:bucket\n' +
        `Motivo: ${causa instanceof Error ? causa.message : String(causa)}`,
    );
  }
  conferirBucketEsperado(config.bucket);
  return config;
}
