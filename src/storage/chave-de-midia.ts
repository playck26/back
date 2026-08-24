import type { Visibilidade } from './storage-provider.interface';

/**
 * SPEC-017/TASK-003 — a gramática da chave de objeto.
 *
 *     empresas/<company_id>/<tipo>/<recurso>/<sha256>.webp
 *
 * **Fonte única.** Montar e parsear vivem neste arquivo, e há teste de
 * paridade provando que um desfaz o outro. É o mesmo raciocínio que a spec
 * usa para o `bigint` do advisory lock: duas formas de definir a mesma coisa
 * é não ter nenhuma — e aqui o preço de discordarem é imagem de uma empresa
 * alcançável por outra.
 *
 * **O parser é total** (AC-019): chave corrompida devolve inválido, **nunca
 * lança**. Parser que explode num 500 é caminho novo de falha; parser que
 * "tenta consertar" é caminho permissivo. Os dois são piores que recusar.
 *
 * **E ele é a segunda camada real, não a mesma checagem repetida** (INV-037):
 * pega **chave adulterada no banco** — cenário que o prefixo e o escopo por
 * token não pegam, porque os dois leem o mesmo token. Se o dado no banco
 * estiver errado, só o parser percebe.
 */

/**
 * Os tipos de mídia, com a visibilidade de cada um.
 *
 * **Por que este registro mora na SPEC-017 e não na 018**, mesmo as colunas
 * e as rotas sendo de lá: o parser só consegue ser fail-closed contra um
 * conjunto **fechado**. Tipo desconhecido tem de ser recusado, e para isso
 * alguém precisa saber quais existem. A 018 traz as colunas que usam cada
 * tipo; o vocabulário da chave é da gramática, e a gramática é daqui.
 *
 * A visibilidade vem junto porque é dela que sai o regime de leitura
 * (REQ-003): pública pelo CDN, privada por URL assinada. Deixar o chamador
 * escolher seria deixá-lo servir foto de aluno por URL permanente.
 */
export const TIPOS_DE_MIDIA = {
  /** `usuarios.foto_key` — foto de perfil de quem tem conta. */
  perfil: { visibilidade: 'privado' },
  /** `professores.foto_key` — ficha de professor sem conta. */
  professor: { visibilidade: 'privado' },
  /** `quadras.imagem_key` — pública por decisão de produto (SPEC-018). */
  quadra: { visibilidade: 'publico' },
  /** `empresas.logo_key` — material corporativo. */
  logo: { visibilidade: 'publico' },
} as const satisfies Record<string, { visibilidade: Visibilidade }>;

export type TipoDeMidia = keyof typeof TIPOS_DE_MIDIA;

export const TIPOS_CONHECIDOS = Object.keys(TIPOS_DE_MIDIA) as TipoDeMidia[];

export function visibilidadeDe(tipo: TipoDeMidia): Visibilidade {
  return TIPOS_DE_MIDIA[tipo].visibilidade;
}

export const PREFIXO_DE_EMPRESA = 'empresas';
export const EXTENSAO = '.webp';

/**
 * UUID canônico **em minúsculas**. Maiúscula recusa, e é decisão, não
 * descuido: chave de objeto no S3 é case-sensitive, então `.../A1B2/...` e
 * `.../a1b2/...` são dois objetos diferentes. Aceitar as duas formas criaria
 * duas chaves para o mesmo recurso — e o CHECK da fila
 * (`split_part(key,'/',2) = company_id::text`, que o Postgres emite em
 * minúsculas) recusaria a maiúscula na hora de enfileirar a exclusão,
 * deixando o objeto órfão no bucket.
 *
 * Confirmado como defesa na validação cruzada de 2026-08-24, que delegou a
 * este parser a obrigação de canonicalizar ou recusar. Aqui **recusa**:
 * canonicalizar em silêncio esconderia de onde veio a chave errada.
 */
const UUID_MINUSCULO =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** sha256 em hexadecimal minúsculo — 64 caracteres, nem um a mais. */
const SHA256_MINUSCULO = /^[0-9a-f]{64}$/;

const SEGMENTOS = 5;

export interface PartesDaChave {
  readonly companyId: string;
  readonly tipo: TipoDeMidia;
  readonly recursoId: string;
  readonly sha256: string;
}

export interface ChaveDeMidia extends PartesDaChave {
  readonly key: string;
  readonly visibilidade: Visibilidade;
}

export type ResultadoDoParse =
  | { readonly valida: true; readonly chave: ChaveDeMidia }
  | { readonly valida: false; readonly motivo: string };

function invalida(motivo: string): ResultadoDoParse {
  return { valida: false, motivo };
}

/**
 * Monta a chave. Recusa parte malformada em vez de produzir chave inválida:
 * gerar uma chave que o próprio parser recusaria seria fabricar o objeto
 * órfão na origem.
 */
export function montarChave(partes: PartesDaChave): string | null {
  if (
    !UUID_MINUSCULO.test(partes.companyId) ||
    !UUID_MINUSCULO.test(partes.recursoId) ||
    !SHA256_MINUSCULO.test(partes.sha256) ||
    !Object.prototype.hasOwnProperty.call(TIPOS_DE_MIDIA, partes.tipo)
  ) {
    return null;
  }
  return [
    PREFIXO_DE_EMPRESA,
    partes.companyId,
    partes.tipo,
    partes.recursoId,
    `${partes.sha256}${EXTENSAO}`,
  ].join('/');
}

/**
 * Parseia a chave. **Total**: qualquer entrada devolve `valida: false` em
 * vez de lançar (AC-019).
 */
export function parsearChave(key: unknown): ResultadoDoParse {
  if (typeof key !== 'string' || key.length === 0) {
    return invalida('chave ausente');
  }

  // Sem `normalize()`, sem `trim()`, sem `toLowerCase()`: cada um deles é uma
  // forma de aceitar uma chave que não é a chave. A comparação é byte a byte
  // porque o S3 também é.
  const segmentos = key.split('/');
  if (segmentos.length !== SEGMENTOS) {
    return invalida(
      `esperava ${SEGMENTOS} segmentos, veio ${segmentos.length}`,
    );
  }

  const [prefixo, companyId, tipo, recursoId, arquivo] = segmentos;

  if (prefixo !== PREFIXO_DE_EMPRESA) {
    return invalida('não começa por empresas/');
  }
  if (!UUID_MINUSCULO.test(companyId)) {
    // Cobre `.`, `..`, vazio, maiúscula e qualquer outra coisa: o UUID
    // canônico não tem ponto nem barra, então travessia de caminho morre
    // aqui sem precisar de regra própria contra ela.
    return invalida('company_id não é UUID canônico minúsculo');
  }
  if (!Object.prototype.hasOwnProperty.call(TIPOS_DE_MIDIA, tipo)) {
    return invalida('tipo de mídia desconhecido');
  }
  if (!UUID_MINUSCULO.test(recursoId)) {
    return invalida('recurso não é UUID canônico minúsculo');
  }
  if (!arquivo.endsWith(EXTENSAO)) {
    return invalida('extensão não é .webp');
  }
  const sha256 = arquivo.slice(0, -EXTENSAO.length);
  if (!SHA256_MINUSCULO.test(sha256)) {
    return invalida('nome do arquivo não é um sha256 hexadecimal minúsculo');
  }

  const tipoConhecido = tipo as TipoDeMidia;
  return {
    valida: true,
    chave: {
      key,
      companyId,
      tipo: tipoConhecido,
      recursoId,
      sha256,
      visibilidade: visibilidadeDe(tipoConhecido),
    },
  };
}

export interface EsperadoDaChave {
  /** Sempre do token, nunca de parâmetro do cliente. */
  readonly companyId: string;
  readonly tipo: TipoDeMidia;
  readonly recursoId: string;
  /** Opcional: quando informada, o regime pedido tem de bater com o do tipo. */
  readonly visibilidade?: Visibilidade;
}

/**
 * AC-018 — parseia **e confere** contra o que veio de query tenant-scoped.
 *
 * A recusa é sempre a mesma do lado de fora (404), e o motivo fica só no
 * log: dizer "existe, mas não é sua" confirmaria a existência do objeto.
 */
export function conferirChave(
  key: unknown,
  esperado: EsperadoDaChave,
): ResultadoDoParse {
  const resultado = parsearChave(key);
  if (!resultado.valida) {
    return resultado;
  }
  const { chave } = resultado;

  if (chave.companyId !== esperado.companyId) {
    // O caso que a spec chama de "chave adulterada no banco": o prefixo e o
    // escopo por token leem o mesmo token e concordariam. Só a comparação
    // com a linha percebe.
    return invalida('chave de outra empresa');
  }
  if (chave.tipo !== esperado.tipo) {
    return invalida('tipo de mídia não é o do recurso pedido');
  }
  if (chave.recursoId !== esperado.recursoId) {
    return invalida('chave de outro recurso');
  }
  if (
    esperado.visibilidade !== undefined &&
    esperado.visibilidade !== chave.visibilidade
  ) {
    // Pedir regime público para tipo privado é o caminho pelo qual foto de
    // aluno viraria URL permanente de CDN.
    return invalida('regime de visibilidade não é o do tipo');
  }

  return resultado;
}
