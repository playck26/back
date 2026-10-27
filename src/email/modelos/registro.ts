import type { ConfiguracaoDosModelos } from '../email.config';
import type { MensagemDeEmail } from '../provedor-de-email';
import { CONVITE_DE_ACESSO } from './convite-de-acesso';
import { REDEFINICAO_DE_SENHA } from './redefinicao-de-senha';

/**
 * SPEC-090/D8 — **o registro dos modelos de e-mail, num arquivo próprio.** O
 * `convite-de-acesso.ts` dizia: "mora neste arquivo enquanto há um modelo;
 * com o segundo, vale um arquivo próprio". O segundo é o
 * `redefinicao_de_senha`.
 */

/**
 * O contrato de todo modelo, e o que os testes do AC-028 e do AC-041 (SPEC-083)
 * e do AC-019 (SPEC-090) iteram.
 *
 * `renderizar` é método, e não propriedade com função, para o registro
 * aceitar modelos com dados de formatos diferentes.
 *
 * `string | number` nos dados, e não só `string`: o único dado variável da
 * redefinição é o número de contas (D8), e um inteiro escrito como texto
 * deixaria o modelo aceitar `"três"`.
 */
export interface ModeloDeEmail<
  Dados extends Record<string, string | number> = Record<
    string,
    string | number
  >,
> {
  readonly nome: string;
  renderizar(config: ConfiguracaoDosModelos, dados: Dados): MensagemDeEmail;
  /**
   * Os campos que vêm de pessoa (gestor, aluno, professor). Todos passam por
   * `escaparHtml()` no HTML, e o teste injeta em cada um, **um de cada vez**:
   * tirar o escape de um campo derruba só o caso daquele campo (S5).
   *
   * `string`, e não `keyof Dados`: o `keyof` tornaria o tipo invariante e o
   * registro recusaria o modelo. O teste confere que cada campo existe em
   * `exemplo`.
   *
   * **Pode ser vazio** (SPEC-090/D8): o e-mail de redefinição não leva nome
   * de pessoa nem de clube. Quanto cada modelo declara é oráculo do
   * `email.spec.ts`, por modelo — um vazio por engano no convite reprova lá.
   */
  readonly camposDePessoa: readonly string[];
  /** Dados válidos, de onde o teste parte para trocar um campo. */
  readonly exemplo: Dados;
}

/**
 * **O registro.** Um modelo novo entra aqui e herda, sem teste novo, as provas
 * de escape e de imagem única; a do banner primeiro e as do remetente e dos
 * campos de pessoa, não: elas são por modelo (a cópia revisada e o mapa de
 * oráculos do `email.spec.ts`), e o teste reprova o modelo do registro que
 * não tiver as suas.
 */
export const MODELOS_DE_EMAIL: readonly ModeloDeEmail[] = [
  CONVITE_DE_ACESSO,
  REDEFINICAO_DE_SENHA,
];
