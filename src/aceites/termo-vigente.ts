/**
 * SPEC-024 — **a versão do termo da plataforma que está valendo.**
 *
 * Mora numa constante, e não numa consulta a `MAX(versao)`, por uma razão de
 * custo: o portão do aceite roda em **toda requisição autenticada**, dentro
 * do `JwtAuthGuard`. Um `MAX()` por requisição seria uma segunda ida ao
 * banco para responder uma pergunta cuja resposta só muda quando alguém faz
 * deploy.
 *
 * **O texto continua no banco** (`termos_da_plataforma`), porque o registro
 * legal precisa dele: saber que a pessoa aceitou "a v1" não vale nada se a
 * v1 não puder ser lida depois.
 *
 * **Publicar uma versão nova é, deliberadamente, um ato de duas partes:**
 * subir a linha nova na tabela (por migration) e subir este número. Se só a
 * linha subir, ninguém é obrigado a reaceitar; se só o número subir, o
 * portão exige uma versão cujo texto não existe — e é por isso que a
 * migration da v1 insere a linha **antes** de qualquer coisa passar a
 * exigi-la.
 *
 * O passo seguinte natural, quando houver uma v2, é uma prova que compare
 * esta constante com o `MAX(versao)` da tabela e falhe se divergirem.
 */
export const TERMO_VERSAO_VIGENTE = 1;
