import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';

/**
 * SPEC-062/D1b, D1c, D1d — **o único arquivo do `src/` que lê a chave privada.**
 *
 * ## Por que "único" é uma regra, e não uma preferência
 *
 * É o gate **G5** da D1d: `git -C apps/Back grep -l -F 'PUSH_VAPID_PRIVATE_KEY'
 * -- src | wc -l` tem de devolver **1**. Leitura espalhada é como um
 * `console.log` de depuração acaba imprimindo segredo — e a invariante INV-062b
 * (a chave privada não sai do servidor) já caiu três vezes na validação por
 * motivos diferentes. Aqui ela tem um lugar só.
 *
 * ## Falha fechada, e VISÍVEL (D1c)
 *
 * Faltando qualquer das três variáveis, o serviço nasce desligado: a rota de
 * assinar responde `503`, a rota da chave pública responde
 * `503 PUSH_NAO_CONFIGURADO` e o tick não roda.
 *
 * **E o operador precisa DESCOBRIR isso**, não deduzir por reclamação de aluno
 * (achado 07 da 1ª rodada). Por isso o log de inicialização nomeia as que
 * faltam — **nomes, nunca valores, nem fragmento**: mascarar (`BN4x…`) já
 * vazaria tamanho e alfabeto, e o log é o lugar mais fácil de vazar segredo.
 *
 * ## A impressão, e por que publicá-la é seguro
 *
 * `impressaoDaPrivada` é o `sha256` do TEXTO da chave privada, e ela sai na
 * rota pública de propósito: é o insumo do gate **G7**, que procura o VALOR da
 * chave dentro do bundle publicado **sem nunca receber o valor**. A chave VAPID
 * privada são 32 bytes aleatórios; inverter `sha256` sobre 2^256 não acontece.
 *
 * Foi assim que o achado da 4ª rodada fechou: os gates anteriores procuravam o
 * NOME da variável, e bastava cadastrá-la na Netlify como `NEXT_PUBLIC_PUSH_KEY`
 * para passar por todos. **O nome não é o portador; o valor é.**
 */
export const PAPEIS_VAPID = [
  'PUSH_VAPID_PUBLIC_KEY',
  'PUSH_VAPID_PRIVATE_KEY',
  'PUSH_VAPID_SUBJECT',
] as const;

export interface ConfiguracaoVapid {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly subject: string;
  /** `sha256` hex do texto da privada. **Não é segredo** — ver o cabeçalho. */
  readonly impressaoDaPrivada: string;
}

export interface EstadoDoVapid {
  /** `null` quando falta variável: o serviço nasce desligado. */
  readonly configuracao: ConfiguracaoVapid | null;
  /** Os NOMES que faltam. Nunca valores. */
  readonly faltando: readonly string[];
}

/**
 * Lê as três variáveis e devolve o estado. **Não lança:** faltar configuração
 * é estado operacional legítimo (o ambiente de desenvolvimento não tem par), e
 * derrubar o app por isso tiraria do ar tudo o que não é push.
 */
export function lerEstadoDoVapid(config: ConfigService): EstadoDoVapid {
  const valores = new Map<string, string>();
  const faltando: string[] = [];

  for (const papel of PAPEIS_VAPID) {
    const valor = config.get<string>(papel)?.trim();
    if (!valor) {
      faltando.push(papel);
      continue;
    }
    valores.set(papel, valor);
  }

  if (faltando.length > 0) {
    return { configuracao: null, faltando };
  }

  const privateKey = valores.get('PUSH_VAPID_PRIVATE_KEY') as string;
  return {
    faltando: [],
    configuracao: {
      publicKey: valores.get('PUSH_VAPID_PUBLIC_KEY') as string,
      privateKey,
      subject: valores.get('PUSH_VAPID_SUBJECT') as string,
      impressaoDaPrivada: createHash('sha256').update(privateKey).digest('hex'),
    },
  };
}

/**
 * D1c/1 — o log de inicialização. Uma vez, no `error`, com os NOMES.
 *
 * `error` e não `warn` de propósito: push desligado é configuração ausente em
 * produção, e o nível é o que separa "alguém olha" de "some no volume".
 */
export function registrarEstadoNoBoot(
  estado: EstadoDoVapid,
  logger: Logger,
): void {
  if (estado.faltando.length > 0) {
    logger.error(`push desligado: faltam ${estado.faltando.join(', ')}`);
    return;
  }
  logger.log('push configurado (par VAPID presente).');
}
