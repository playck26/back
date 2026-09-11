-- SPEC-047 — o preço da aula particular sai do corpo do pedido e vai para a
-- tabela. Fecha a LIM-039d e, com ela, o DEF-029.
--
-- ## O DEF-029, medido em 2026-09-11
--
-- `POST /bookings` aceita `@Roles('company_admin', 'aluno')` e nunca conferiu
-- o papel de quem manda `professorId` e `valor`. Medido: o aluno marcou aula
-- particular para si mesmo por **R$ 1,00** e a carteira dele debitou R$ 1,00.
--
-- O comentário do próprio campo `valor` já dizia que o risco existia -- *"num
-- campo que a carteira debita"* -- e a trava foi posta em `valor` EXIGIR
-- `professorId`, nunca em QUEM pode mandar `professorId`.
BEGIN;

-- =====================================================================
-- O preço do professor, e o padrão do clube
-- =====================================================================
--
-- **`DECIMAL(10,2)`, em REAIS**, igual a `quadras.preco_hora` e a
-- `ocupacoes_quadra.valor`. Não é centavos, e é deliberado: a coluna que
-- recebe o valor é decimal, e converter duas vezes no caminho é como erro de
-- fator 100 nasce. *A carteira é em centavos e continua sendo — a conversão já
-- existe, e é de lá.*
--
-- **Nulo significa "usa o padrão do clube", nunca "de graça"** (D1). É o molde
-- que `prazo_cancelamento_aula_horas` e `reposicoes_por_mes` já usam, e a lição
-- está escrita no `ConfigOperacaoService`: *"`prazo ?? 0` compila neste
-- projeto, e produziria prazo de zero horas, que é o oposto de sem prazo"*.
ALTER TABLE "professores"
  ADD COLUMN "preco_aula" DECIMAL(10,2);

ALTER TABLE "config_operacao_empresa"
  ADD COLUMN "preco_aula_padrao" DECIMAL(10,2);

-- =====================================================================
-- INV-122 — preço de aula é positivo quando existe
-- =====================================================================
--
-- **Sem isto, um `-1` digitado faria a carteira debitar negativo** — crédito
-- vindo do nada, pela porta de uma aula. E `0` também não passa: zero não é
-- "grátis", é o valor que o ledger recusa (`valor_centavos > 0`), então a aula
-- de graça quebraria na COBRANÇA, depois de a tela ter dito que deu certo.
--
-- Os dois CHECKs aceitam `NULL` de propósito: nulo é a ausência de
-- configuração, e é o que faz a herança funcionar.
ALTER TABLE "professores"
  ADD CONSTRAINT "professores_preco_aula_positivo"
    CHECK ("preco_aula" IS NULL OR "preco_aula" > 0);

ALTER TABLE "config_operacao_empresa"
  ADD CONSTRAINT "config_preco_aula_padrao_positivo"
    CHECK ("preco_aula_padrao" IS NULL OR "preco_aula_padrao" > 0);

COMMIT;
