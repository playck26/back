/**
 * SPEC-017/TASK-001 — a porta do fornecedor de storage.
 *
 * **INV-031: nenhum serviço de domínio importa SDK de storage.** Este
 * arquivo é a fronteira: nada aqui menciona S3, Spaces, ACL ou comando do
 * SDK. Trocar de fornecedor (AC-017) é implementar esta interface e mudar
 * o `.env` — não é tocar em regra de negócio.
 *
 * Por isso até o erro é daqui (`FalhaDeStorage`): se o worker da TASK-005
 * precisasse capturar `S3ServiceException` para gravar `ultimo_erro`
 * (AC-012), o SDK vazaria para o domínio pela porta dos fundos.
 */

/** Regime de leitura do objeto (REQ-003). */
export type Visibilidade = 'publico' | 'privado';

export interface ObjetoParaGravar {
  /** `empresas/<company_id>/<tipo>/<recurso>/<sha256>.webp` (AC-007). */
  readonly key: string;
  readonly corpo: Buffer;
  readonly contentType: string;
  readonly visibilidade: Visibilidade;
}

export interface MetadadosDoObjeto {
  readonly tamanhoBytes: number;
  readonly contentType: string | null;
  readonly cacheControl: string | null;
  readonly etag: string | null;
}

export type OperacaoDeStorage = 'gravar' | 'apagar' | 'metadados' | 'assinar';

/**
 * Falha do fornecedor, traduzida. Carrega a `key` — que não é dado pessoal,
 * é caminho de objeto — e **nunca** a URL assinada (INV-032/AC-011).
 */
export class FalhaDeStorage extends Error {
  constructor(
    readonly operacao: OperacaoDeStorage,
    readonly key: string,
    readonly causa: unknown,
  ) {
    const detalhe = causa instanceof Error ? causa.message : String(causa);
    super(`Falha ao ${operacao} o objeto "${key}": ${detalhe}`);
    this.name = 'FalhaDeStorage';
  }
}

export interface StorageProvider {
  /**
   * Grava (ou sobrescreve) o objeto. Mesmo conteúdo produz a mesma chave,
   * então reenviar é sobrescrever byte a byte: 1 objeto, nenhuma duplicata
   * (AC-008). É o que torna o retry inofensivo.
   */
  gravar(objeto: ObjetoParaGravar): Promise<void>;

  /**
   * Apaga o objeto. Idempotente: apagar o que não existe não é erro — quem
   * decide *se* pode apagar é o worker da TASK-005, com o
   * `KeyReferenceChecker`, a carência e o teto. A porta só executa.
   */
  apagar(key: string): Promise<void>;

  /** `null` quando o objeto não existe. Ausência não é falha. */
  metadados(key: string): Promise<MetadadosDoObjeto | null>;

  /**
   * URL pública, servida pelo CDN — não passa pela API (NFR-002/AC-009).
   * Síncrona porque é concatenação, não chamada de rede.
   */
  urlPublica(key: string): string;

  /**
   * URL assinada, com expiração (AC-010). **Nunca persistir nem logar o
   * retorno** (INV-032/AC-011): ela é a credencial de leitura.
   */
  urlAssinada(key: string, expiraEmSegundos?: number): Promise<string>;
}

export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');
