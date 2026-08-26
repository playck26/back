import type { PrismaService } from '../prisma/prisma.service';

/**
 * SPEC-018/TASK-007 — **a lista de colunas de mídia, e ela é uma só**
 * (INV-045).
 *
 * ## Por que existe um arquivo só para isto
 *
 * A INV-045 diz que o `KeyReferenceChecker` cobre **todas** as colunas de
 * mídia. Uma invariante assim morre em silêncio: alguém acrescenta
 * `quadras.imagem_capa_key` daqui a seis meses, esquece do checker, e o
 * worker passa a apagar arquivo **em uso** — sem erro, sem alerta, só a
 * imagem sumindo da tela de alguém.
 *
 * A defesa contra isso não é lembrar. É a lista existir **num lugar só**, e
 * um teste que a confere contra o schema (AC-017): não contra outra lista
 * escrita à mão, que envelheceria junto com quem a escreveu.
 *
 * ## O que conta como coluna de mídia
 *
 * Coluna que guarda uma **chave de objeto no bucket**. Não é o mesmo que
 * "coluna cujo nome termina em `key`": `arquivos_pendentes_exclusao.key` é a
 * chave que está **na fila para ser apagada**, e tratá-la como referência
 * faria o worker considerar toda chave enfileirada como "ainda em uso" — ele
 * nunca apagaria nada. Ela está declarada como exceção em
 * `colunas-de-midia.spec.ts`, com este motivo, porque exceção sem motivo
 * escrito vira lista à mão outra vez.
 */
export interface ColunaDeMidia {
  /** Nome do modelo no Prisma, como o DMMF o reporta. */
  readonly modelo: string;
  /** Nome do campo no Prisma (camelCase), como o DMMF o reporta. */
  readonly campo: string;
  /**
   * A consulta. Cada coluna traz a sua porque o nome do delegate e o do
   * campo mudam juntos — uma tabela de strings exigiria indexar o
   * `PrismaClient` dinamicamente e perderia o typecheck, que é justamente o
   * que pega renomeação de campo.
   */
  readonly aponta: (prisma: PrismaService, key: string) => Promise<boolean>;
}

const existe = async (contagem: Promise<number>): Promise<boolean> =>
  (await contagem) > 0;

export const COLUNAS_DE_MIDIA: readonly ColunaDeMidia[] = [
  {
    modelo: 'Usuario',
    campo: 'fotoKey',
    aponta: (prisma, key) =>
      existe(prisma.usuario.count({ where: { fotoKey: key } })),
  },
  {
    modelo: 'Professor',
    campo: 'fotoKey',
    aponta: (prisma, key) =>
      existe(prisma.professor.count({ where: { fotoKey: key } })),
  },
  {
    modelo: 'Quadra',
    campo: 'imagemKey',
    aponta: (prisma, key) =>
      existe(prisma.quadra.count({ where: { imagemKey: key } })),
  },
  {
    modelo: 'Empresa',
    campo: 'logoKey',
    aponta: (prisma, key) =>
      existe(prisma.empresa.count({ where: { logoKey: key } })),
  },
] as const;
