import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TipoDeAcao } from '@prisma/client';
import {
  montarAviso,
  PUBLICO_POR_TIPO,
  TIPO_GESTO,
  type FatosDoGesto,
  type PapelDoDestinatario,
} from './avisos-de-gesto';

/**
 * SPEC-063/TASK-001 — **quem recebe o aviso de um gesto, e como a linha
 * entra.**
 *
 * ## O molde é o do `RegistradorDeAcao`, e não por acaso
 *
 * O registrador de auditoria já atravessa os nove serviços de domínio,
 * acumulando efeitos dentro da transação. Este objeto anda ao lado dele com a
 * mesma forma: nasce na transação, recebe os efeitos conforme acontecem, e é
 * despachado **uma vez** no fim.
 *
 * ## As duas idas, e por que exatamente duas
 *
 * `DEF-013` conta as idas ao banco dentro da transação de turma, porque foi um
 * laço dentro dela que derrubou produção com `P2028`. O teto de lá não proíbe
 * custo — proíbe **custo que cresce com o dado**.
 *
 * Por isso este enfileirador gasta **duas idas fixas**, e nunca mais:
 *
 *   1. uma consulta que resolve TODOS os destinatários de uma vez;
 *   2. um `INSERT` só, com todas as linhas em `VALUES`.
 *
 * Dez alunos custam o mesmo que um. Um laço por destinatário aqui seria
 * reintroduzir, com outra roupa, o defeito que o `DEF-013` existe para barrar.
 *
 * ## Por que dentro da transação do gesto
 *
 * Porque um aviso sobre um gesto que voltou atrás é pior que nenhum aviso: a
 * pessoa passa a confiar num aviso que já não descreve o mundo. Se a edição da
 * grade falha, as linhas de aviso vão junto — sem código nenhum para isso.
 *
 * **E é isso que torna o `ON CONFLICT` obrigatório, não detalhe.** Um `23505`
 * dentro da transação **aborta a transação inteira**, e a transação aqui é a do
 * próprio gesto: o gestor editaria a grade, um aviso duplicado dispararia o
 * conflito, e a edição inteira voltaria atrás — com uma mensagem de erro que
 * culpa notificação.
 */

/** Um efeito do gesto. Vários deles viram **um** aviso por destinatário. */
interface EfeitoDoGesto {
  readonly data: Date | null;
  readonly horaInicio: Date | null;
  readonly horaFim: Date | null;
}

interface Destinatario {
  readonly usuarioId: string;
  readonly papel: PapelDoDestinatario;
}

export class EnfileiradorDeAvisos {
  private readonly efeitos: EfeitoDoGesto[] = [];
  private turmaId: string | null = null;
  private alunoRemovidoId: string | null = null;
  private despachado = false;

  constructor(
    private readonly tx: Prisma.TransactionClient,
    private readonly companyId: string,
    private readonly autorId: string,
    private readonly tipo: TipoDeAcao,
  ) {}

  /**
   * Anota um efeito. Chamar N vezes produz **um** aviso por destinatário,
   * com os N contados — é a D3, e a razão de o resumo se montar no fim.
   */
  anotarEfeito(efeito: EfeitoDoGesto): void {
    this.efeitos.push(efeito);
  }

  /** A turma alvo. Necessária para todo gesto de público `turma`. */
  comTurma(turmaId: string): void {
    this.turmaId = turmaId;
  }

  /** O aluno que saiu — o único destinatário de `turma_aluno_removido`. */
  comAlunoRemovido(alunoId: string): void {
    this.alunoRemovidoId = alunoId;
  }

  /**
   * Grava os avisos. Chamado **uma vez**, no fim da transação do gesto.
   *
   * `acaoId` vem de `RegistradorDeAcao.idDaAcao` e é `null` quando o gesto não
   * teve efeito nenhum — saída idempotente, por exemplo. **Gesto que não
   * aconteceu não avisa**, e é por isso que a decisão mora aqui e não no
   * chamador: quem chama não deveria precisar saber disso.
   *
   * @returns quantas linhas de aviso entraram.
   */
  async despachar(acaoId: string | null): Promise<number> {
    if (this.despachado) {
      // Dois despachos gravariam o mesmo `(origem_id, destinatario_id)` duas
      // vezes. O `ON CONFLICT` absorveria, mas a segunda ida seria custo puro
      // dentro da transação — e o `DEF-013` conta idas.
      throw new Error('SPEC-063: despachar() chamado duas vezes');
    }
    this.despachado = true;

    if (acaoId === null || PUBLICO_POR_TIPO[this.tipo] === 'ninguem') {
      return 0;
    }

    const destinatarios = await this.resolverDestinatarios();
    if (destinatarios.length === 0) {
      return 0;
    }

    const fatos = this.fatos();
    const linhas = destinatarios.flatMap((d) => {
      const aviso = montarAviso(this.tipo, d.papel, fatos);
      if (!aviso) {
        return [];
      }
      return [
        Prisma.sql`(${randomUUID()}::uuid, ${this.companyId}::uuid,
                    ${d.usuarioId}::uuid, ${acaoId}::uuid, ${TIPO_GESTO},
                    ${aviso.titulo}, ${aviso.corpo}, ${aviso.destinoUrl},
                    ${aviso.expiraEm})`,
      ];
    });
    if (linhas.length === 0) {
      return 0;
    }

    // **O `DO UPDATE` reescreve as QUATRO colunas que o resumo produz**, e não
    // duas (achado R03 da 2ª rodada). Reescrevendo só `titulo` e `corpo`, a
    // linha ficaria misturada: texto do resumo novo, `destino_url` e
    // `expira_em` do PRIMEIRO efeito gravado — o aviso diria "a grade de uma
    // das suas turmas mudou" e levaria à ocorrência errada, com prazo errado.
    //
    // A regra é simples de enunciar e fácil de errar: coluna que o resumo
    // produz e o `DO UPDATE` não reescreve é coluna que guarda o passado.
    return this.tx.$executeRaw`
      INSERT INTO notificacoes (id, company_id, destinatario_id, origem_id,
                                tipo, titulo, corpo, destino_url, expira_em)
      VALUES ${Prisma.join(linhas)}
      ON CONFLICT (origem_id, destinatario_id) WHERE tipo = 'gesto'
      DO UPDATE SET titulo      = EXCLUDED.titulo,
                    corpo       = EXCLUDED.corpo,
                    destino_url = EXCLUDED.destino_url,
                    expira_em   = EXCLUDED.expira_em`;
  }

  /**
   * **O instante só entra quando há UM efeito.**
   *
   * É a mesma razão da D5 para os resumos não terem prazo: com N ocorrências,
   * escolher uma delas descartaria o resto em silêncio. Vale para a aula
   * cancelada (sempre uma) e para a reserva cancelada em bloco (pode ser
   * várias) sem precisar de duas regras.
   */
  private fatos(): FatosDoGesto {
    const unico = this.efeitos.length === 1 ? this.efeitos[0] : null;
    return {
      quantidade: this.efeitos.length,
      turmaId: this.turmaId,
      data: unico?.data ?? null,
      horaInicio: unico?.horaInicio ?? null,
      horaFim: unico?.horaFim ?? null,
    };
  }

  /**
   * Uma ida ao banco, sempre — qualquer que seja o público.
   *
   * **O autor sai da lista aqui, e não depois:** quem causou o fato não recebe
   * o aviso do próprio ato (D1). Tirar no SQL evita montar texto para alguém
   * que vai ser descartado.
   */
  private async resolverDestinatarios(): Promise<Destinatario[]> {
    const publico = PUBLICO_POR_TIPO[this.tipo];

    if (publico === 'gestores') {
      const linhas = await this.tx.$queryRaw<{ usuario_id: string }[]>`
        SELECT id AS usuario_id FROM usuarios
         WHERE company_id = ${this.companyId}::uuid
           AND role = 'company_admin'
           AND status = 'ativo'
           AND id <> ${this.autorId}::uuid`;
      return linhas.map((l) => ({ usuarioId: l.usuario_id, papel: 'gestor' }));
    }

    if (publico === 'aluno_removido') {
      if (!this.alunoRemovidoId) {
        return [];
      }
      const linhas = await this.tx.$queryRaw<{ usuario_id: string }[]>`
        SELECT usuario_id FROM alunos
         WHERE id = ${this.alunoRemovidoId}::uuid
           AND company_id = ${this.companyId}::uuid
           AND usuario_id <> ${this.autorId}::uuid`;
      return linhas.map((l) => ({ usuarioId: l.usuario_id, papel: 'aluno' }));
    }

    // `turma`: alunos matriculados **e** o professor que tem conta.
    //
    // `UNION ALL` com desempate na aplicação, e não `UNION`: os dois lados
    // trazem colunas diferentes (`papel`), então o `UNION` não dedupe quem for
    // aluno E professor da mesma turma — e duas linhas com o mesmo
    // `(origem_id, destinatario_id)` no mesmo `INSERT` dão erro `21000`,
    // "ON CONFLICT DO UPDATE command cannot affect row a second time".
    if (!this.turmaId) {
      return [];
    }
    const linhas = await this.tx.$queryRaw<
      { usuario_id: string; papel: string }[]
    >`
      SELECT a.usuario_id, 'aluno' AS papel
        FROM turma_alunos ta
        JOIN alunos a ON a.id = ta.aluno_id
       WHERE ta.turma_id = ${this.turmaId}::uuid
         AND a.company_id = ${this.companyId}::uuid
         AND a.usuario_id <> ${this.autorId}::uuid
      UNION ALL
      -- LIM-063e: professores.usuario_id e anulavel, e a ficha existe
      -- justamente para o professor que ainda nao tem login. Sem conta nao ha
      -- destinatario possivel: o gesto acontece, so o aviso nao sai.
      SELECT p.usuario_id, 'professor' AS papel
        FROM turmas t
        JOIN professores p ON p.id = t.professor_id
       WHERE t.id = ${this.turmaId}::uuid
         AND t.company_id = ${this.companyId}::uuid
         AND p.usuario_id IS NOT NULL
         AND p.usuario_id <> ${this.autorId}::uuid`;

    const vistos = new Set<string>();
    const destinatarios: Destinatario[] = [];
    for (const l of linhas) {
      if (vistos.has(l.usuario_id)) {
        continue;
      }
      vistos.add(l.usuario_id);
      destinatarios.push({
        usuarioId: l.usuario_id,
        papel: l.papel === 'professor' ? 'professor' : 'aluno',
      });
    }
    return destinatarios;
  }
}
