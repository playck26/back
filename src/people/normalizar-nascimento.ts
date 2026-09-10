import { UnprocessableEntityException } from '@nestjs/common';
import { hojeNoFusoDoClube } from '../courts/date-time.util';

/**
 * SPEC-036/AC-004 — a data de nascimento, do corpo para o banco.
 *
 * ## Por que a validacao vive AQUI e tambem no banco
 *
 * O `CHECK alunos_nascimento_plausivel` devolveria `23514`, que vaza como
 * `500` — erro de banco chegando ao cliente como falha do servidor, quando o
 * que houve foi um dado recusado. Daqui sai `422 DATA_NASCIMENTO_INVALIDA`,
 * que a tela sabe onde mostrar.
 *
 * O CHECK continua existindo porque a aplicacao **nao e o unico caminho**: a
 * SPEC-038 vai importar aluno por planilha, e a rede de baixo precisa estar la
 * quando alguem escrever direto.
 *
 * ## O fuso, de novo (DEF-020)
 *
 * `new Date('1990-05-10')` e interpretado como **meia-noite UTC**, e a coluna
 * e `DATE`. Em fuso negativo isso ja virou o dia anterior neste projeto mais
 * de uma vez. `Date.UTC` com as partes explicitas nao tem esse problema, e e o
 * mesmo idioma da `marcar-aula-particular` no Admin.
 */
export function normalizarNascimento(
  valor: string | null | undefined,
): Date | null | undefined {
  // `undefined` nao mexe; `null` apaga. Duas intencoes diferentes, e o Prisma
  // ja as distingue — traduzir uma na outra aqui apagaria dado por engano.
  if (valor === undefined) return undefined;
  if (valor === null) return null;

  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor);
  if (!partes) {
    throw new UnprocessableEntityException({
      statusCode: 422,
      code: 'DATA_NASCIMENTO_INVALIDA',
      message: 'A data de nascimento precisa estar no formato AAAA-MM-DD.',
    });
  }
  const [, ano, mes, dia] = partes;
  const data = new Date(Date.UTC(Number(ano), Number(mes) - 1, Number(dia)));

  /**
   * `2026-02-31` casa o regex e vira **3 de marco** no `Date.UTC`. Sem esta
   * conferencia, uma data impossivel seria gravada como outra data — silencio
   * pior que erro.
   *
   * A comparacao e pela **ida e volta da string**, e nao por
   * `getUTCFullYear()/getUTCMonth()/getUTCDate()`: alem de ser uma linha em
   * vez de tres, o gate `fuso-do-clube.spec.ts` recusa `getUTCFullYear()` em
   * qualquer lugar de `src/` — a premissa dele e que quem le esse metodo esta
   * montando a data de "agora", e uma excecao aqui enfraqueceria a regra para
   * o proximo caso, que talvez seja o defeito de verdade.
   */
  if (data.toISOString().slice(0, 10) !== valor) {
    throw new UnprocessableEntityException({
      statusCode: 422,
      code: 'DATA_NASCIMENTO_INVALIDA',
      message: 'Esta data nao existe no calendario.',
    });
  }

  /**
   * **`hojeNoFusoDoClube()`, nunca `new Date()` cru** — e quem me lembrou foi
   * o gate `o fuso do clube e a unica convencao de "hoje"`, que reprovou a
   * primeira versao deste arquivo.
   *
   * As 21h de um 09/09 no Brasil, o relogio UTC do servidor ja esta em 10/09:
   * uma data de nascimento de "amanha" passaria pelo teto. E pequeno, e e
   * exatamente a familia de defeito da DEF-020 — que ja custou a este projeto
   * uma grade de turma inteira gerada a partir do dia errado.
   */
  const hojeUTC = hojeNoFusoDoClube();
  // O piso de 1900 nao e supersticao: sem ele, um dedo escorregado em
  // `0202-05-10` passa e a idade na tela vira 1824 anos.
  if (data <= new Date(Date.UTC(1900, 0, 1)) || data > hojeUTC) {
    throw new UnprocessableEntityException({
      statusCode: 422,
      code: 'DATA_NASCIMENTO_INVALIDA',
      message:
        'A data de nascimento precisa ser posterior a 1900 e nao pode estar no futuro.',
    });
  }
  return data;
}
