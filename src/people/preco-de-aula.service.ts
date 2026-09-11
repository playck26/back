import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** O que o Prisma devolve para uma coluna `Decimal` — ou nada. */
type Preco = { toString(): string } | number | null | undefined;

/**
 * SPEC-047/D1 — **a regra do preço da aula, num lugar só.**
 *
 * ## Por que ela saiu de dentro do `CourtsService`
 *
 * `professor.precoAula ?? config.precoAulaPadrao` nasceu duplicada de
 * propósito, e o docstring do `ProfessoresParaAlunoService` declarou a
 * condição de saída em vez de esconder o débito:
 *
 * > *"se uma terceira cópia aparecer, aí a extração passa a valer a pena"*
 *
 * A terceira apareceu (`HorariosDeAulaParticularService`, que precisa recusar
 * o professor sem preço antes de oferecer horário dele). **Esta classe é o
 * cumprimento daquela condição, não uma refatoração oportunista.**
 *
 * ## O que é compartilhado é a REGRA, não a consulta
 *
 * As três chamadas leem de formas legitimamente diferentes — uma dentro de
 * criação de reserva, uma em lote para a lista inteira, uma para um professor
 * só. Forçar uma consulta única produziria a função que recebe `tx` ou não e
 * devolve um ou vários, que é pior que as três.
 *
 * Por isso `resolver` é **estática e pura**: é a única linha que não pode
 * divergir. Quem consulta continua consultando do jeito que lhe serve.
 */
@Injectable()
export class PrecoDeAulaService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * **Professor → clube → nada.** `null` quando nenhum dos dois tem preço, e
   * quem chama decide o que fazer com isso.
   *
   * Não cai no preço da quadra (D2) e **não devolve zero**: zero é o valor que
   * o ledger recusa, e a aula de graça quebraria na cobrança depois de a tela
   * já ter dito que deu certo.
   */
  static resolver(doProfessor: Preco, padraoDoClube: Preco): number | null {
    const preco = doProfessor ?? padraoDoClube ?? null;
    return preco == null ? null : Number(preco);
  }

  /**
   * O padrão do clube, sozinho — para quem já tem os professores em mãos e
   * não vai pagar uma consulta de config por linha da lista.
   */
  async padraoDoClube(companyId: string): Promise<number | null> {
    const config = await this.prisma.configOperacaoEmpresa.findUnique({
      where: { companyId },
      select: { precoAulaPadrao: true },
    });
    return config?.precoAulaPadrao == null
      ? null
      : Number(config.precoAulaPadrao);
  }

  /**
   * O preço de **um** professor, resolvido.
   *
   * Uma consulta só para os dois lados: o preço é lido em toda criação de aula
   * particular, e duas idas ao banco por reserva é o tipo de custo que ninguém
   * vê até a agenda de um sábado.
   *
   * Professor de outra empresa cai aqui como `null` — e o `404` correto vem do
   * portão de existência de quem chamou. **A ordem é da SPEC-039 e não muda:
   * existência antes de preço.** Inverter fez, uma vez, o professor de outra
   * empresa responder `AULA_SEM_PRECO` em vez de `404`, e foram os testes da
   * SPEC-039 que pegaram.
   */
  async doProfessor(
    companyId: string,
    professorId: string,
  ): Promise<number | null> {
    const [professor, config] = await Promise.all([
      this.prisma.professor.findFirst({
        where: { id: professorId, companyId },
        select: { precoAula: true },
      }),
      this.prisma.configOperacaoEmpresa.findUnique({
        where: { companyId },
        select: { precoAulaPadrao: true },
      }),
    ]);
    return PrecoDeAulaService.resolver(
      professor?.precoAula,
      config?.precoAulaPadrao,
    );
  }
}
