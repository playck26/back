/**
 * SPEC-036 — **a completude do cadastro do aluno.**
 *
 * ## Função pura, e o cálculo nunca é gravado (D2/INV-111)
 *
 * Não há coluna `completude_pct`, e a ausência é a decisão. A **SPEC-037 vai
 * acrescentar plano e contrato à matrícula**, e no dia em que isso entrar toda
 * percentagem gravada estaria errada — uma afirmação sobre um passado que
 * ninguém consegue localizar. Calcular custa zero idas ao banco: quem chama já
 * tem a linha carregada.
 *
 * ## O que a resposta traz, e por que não é só o número
 *
 * `70%` não diz a ninguém o que fazer. `faltam: ["dataNascimento"]` diz. É a
 * mesma lição que a SPEC-035 pagou do outro lado: a mensagem crua do servidor
 * não dizia **quantos** conflitos, e sem a contagem o gestor não sabia se
 * liberava uma quadra ou seis.
 *
 * ## Pesos iguais, de propósito (D5)
 *
 * Nada de peso 3 para data de nascimento e 1 para cidade. **Peso é opinião
 * disfarçada de número**, e a primeira pergunta de quem vê `62%` seria "por
 * quê 62?" — sem resposta defensável. Sete campos, `preenchidos / 7`.
 *
 * ## E o piso real é 29%, nunca 0% (AC-011)
 *
 * `nome` e `email` são `NOT NULL` em `usuarios`: todo aluno já nasce com dois
 * dos sete. Uma barra que começasse em zero mentiria sobre o trabalho que já
 * foi feito — e quem vê 0% depois de cadastrar alguém conclui que o cadastro
 * não salvou.
 */

/**
 * Os sete que contam, **na ordem em que a tela deve pedi-los** (AC-010).
 *
 * A ordem não é alfabética nem a do banco: é a do formulário. `telefone` antes
 * de `nivelId` porque quem acabou de se cadastrar sabe o próprio telefone e
 * pode não saber o próprio nível.
 *
 * **Endereço, cidade, UF e observações de saúde NÃO estão aqui** (D6). Eles
 * existem, são editáveis e aparecem na ficha — só não cobram. *Uma barra que
 * ninguém consegue encher vira enfeite*, e a faixa de incentivo perde a razão
 * de existir.
 */
export const CAMPOS_DA_COMPLETUDE = [
  'nome',
  'email',
  'telefone',
  'dataNascimento',
  'emergenciaNome',
  'emergenciaTelefone',
  'nivelId',
] as const;

export type CampoDaCompletude = (typeof CAMPOS_DA_COMPLETUDE)[number];

export interface CompletudeDoCadastro {
  percentual: number;
  faltam: CampoDaCompletude[];
}

/**
 * O que a função precisa saber. **Aceita `undefined` além de `null`** porque
 * um `select` parcial do Prisma não traz a chave — e um campo ausente da
 * consulta contaria como preenchido se só `null` fosse testado, que é o pior
 * erro possível aqui: a barra subiria sozinha.
 */
export interface DadosParaCompletude {
  nome?: string | null;
  email?: string | null;
  telefone?: string | null;
  dataNascimento?: Date | string | null;
  emergenciaNome?: string | null;
  emergenciaTelefone?: string | null;
  nivelId?: string | null;
}

/**
 * Preenchido é: existe, e não é texto em branco.
 *
 * O `btrim` do banco (`alunos_texto_nao_vazio`) impede `''` **daqui para
 * frente**; linhas anteriores à SPEC-036 podem trazer o que quiserem, e
 * `nome: '   '` contando como preenchido faria a barra mentir sobre dado
 * legado. A checagem é de graça e cobre os dois mundos.
 */
function preenchido(valor: unknown): boolean {
  if (valor === null || valor === undefined) return false;
  if (typeof valor === 'string') return valor.trim() !== '';
  return true;
}

export function calcularCompletude(
  dados: DadosParaCompletude,
): CompletudeDoCadastro {
  const faltam = CAMPOS_DA_COMPLETUDE.filter(
    (campo) => !preenchido(dados[campo]),
  );
  const preenchidos = CAMPOS_DA_COMPLETUDE.length - faltam.length;
  return {
    // `Math.round` e não `floor`: com 7 campos, 5 preenchidos dá 71,43 — e
    // `floor` mostraria 71 enquanto 6 de 7 mostraria 85. A distorção é
    // pequena e sempre para baixo, o que faz a barra parecer travada.
    percentual: Math.round((preenchidos / CAMPOS_DA_COMPLETUDE.length) * 100),
    faltam: [...faltam],
  };
}
