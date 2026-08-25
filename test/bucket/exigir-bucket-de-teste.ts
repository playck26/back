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
 * Aqui a trava tem duas partes:
 *
 * 1. **Só roda com as 6 variáveis presentes.** Sem elas falha na hora, com a
 *    instrução de como rodar — em vez de conectar em algum lugar por
 *    acidente.
 * 2. **Só escreve sob um prefixo próprio.** Todo objeto criado aqui vive sob
 *    `empresas/<EMPRESA_DE_TESTE>/`, e a limpeza apaga **por esse prefixo**.
 *    Não existe caminho neste arquivo que apague outra coisa.
 *
 * O bucket é compartilhado de fato: `playck-media` passa a guardar mídia de
 * produção na SPEC-018. Um `DELETE` largo aqui seria o incidente de novo,
 * com outro nome.
 */

/**
 * Empresa fictícia da suíte. **Nenhum dado real vive sob este prefixo**, e é
 * ele que delimita tudo o que o FIT-006 pode criar ou apagar.
 */
export const EMPRESA_DE_TESTE = 'f17006f1-7006-4f17-8006-f17006f17006';
export const PREFIXO_DE_TESTE = `empresas/${EMPRESA_DE_TESTE}/`;

export function exigirBucketDeTeste(): StorageConfig {
  const fake = { get: (nome: string) => process.env[nome] } as ConfigService;
  try {
    return carregarStorageConfig(fake);
  } catch (causa) {
    throw new Error(
      'FIT-006 precisa das 6 variáveis SPACES_* e fala com o bucket REAL.\n' +
        'Rode assim, de propósito:\n' +
        '  set -a; . ./.env; set +a; pnpm run test:bucket\n' +
        `Motivo: ${causa instanceof Error ? causa.message : String(causa)}`,
    );
  }
}
