import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parsearChave } from './chave-de-midia';

/** Cliente do Prisma que serve tanto o `PrismaService` quanto um `tx`. */
export interface ClienteDeFila {
  $executeRaw(
    query: TemplateStringsArray,
    ...valores: unknown[]
  ): Promise<number>;
}

export interface PedidoDeEnfileiramento {
  /** A chave que deixou de ser referenciada. */
  readonly chaveAnterior: string | null | undefined;
  /** A chave que passou a valer, se houver. */
  readonly chaveNova?: string | null;
  readonly motivo: string;
}

/**
 * SPEC-017/TASK-005 — a porta de entrada da fila (AC-012/013, INV-038).
 *
 * **A regra que parece boba e não é** (AC-013): se a chave nova for igual à
 * anterior, **nada** é enfileirado. A chave é derivada do conteúdo, então
 * reenviar a mesma foto — ou trocar A → B → A — produz a mesma chave, e a
 * lógica ingênua "troquei, enfileiro a anterior" apagaria o objeto que
 * **acabou de virar o atual**.
 *
 * Esta é a primeira das três defesas. A segunda é a reconferência do worker
 * (AC-014), e a terceira é o advisory lock (INV-039) — que entrou contra a
 * minha aposta de que não precisava.
 */
@Injectable()
export class FilaDeExclusao {
  private readonly logger = new Logger(FilaDeExclusao.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Enfileira a chave anterior, se houver o que enfileirar.
   *
   * Aceita um `tx` porque a INV-038 exige que **toda** chave que sai do banco
   * entre na fila: enfileirar fora da transação que apagou a referência abre
   * a janela em que o processo morre no meio e o objeto fica órfão para
   * sempre.
   */
  async enfileirar(
    pedido: PedidoDeEnfileiramento,
    cliente: ClienteDeFila = this.prisma,
  ): Promise<'enfileirada' | 'sem_chave' | 'chave_igual' | 'chave_invalida'> {
    const { chaveAnterior, chaveNova, motivo } = pedido;

    if (!chaveAnterior) {
      return 'sem_chave';
    }
    if (chaveNova && chaveNova === chaveAnterior) {
      // AC-013. Sem esta linha, reenviar a mesma foto agenda a exclusão do
      // objeto que a própria requisição acabou de confirmar.
      return 'chave_igual';
    }

    const parse = parsearChave(chaveAnterior);
    if (!parse.valida) {
      // Chave que não parseia não pode ser enfileirada: o CHECK da tabela a
      // recusaria, e a exceção apareceria dentro da transação de quem estava
      // só trocando uma foto. Registrar e seguir é o mal menor — mas é
      // registrado, porque chave inválida no banco é a AC-018 acontecendo.
      this.logger.error({
        evento: 'chave_invalida_nao_enfileirada',
        motivoDoParser: parse.motivo,
      });
      return 'chave_invalida';
    }

    // `DO NOTHING`: duas linhas para o mesmo objeto seriam ruído, e fariam a
    // carência (AC-016b) e o teto (AC-016c) contarem o mesmo arquivo duas
    // vezes. A linha antiga preserva o `criado_em` original — a carência
    // conta desde a primeira vez que o objeto ficou órfão, e quem protege
    // contra apagar o que voltou a ser usado é a reconferência, não o prazo.
    await cliente.$executeRaw`
      INSERT INTO arquivos_pendentes_exclusao (id, key, company_id, motivo)
      VALUES (gen_random_uuid(), ${chaveAnterior}, ${parse.chave.companyId}::uuid, ${motivo})
      ON CONFLICT (key) DO NOTHING
    `;
    return 'enfileirada';
  }
}
