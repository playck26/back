-- SPEC-064/TASK-008 — a antecedência da fila de AULA passa a ser do clube.
--
-- Card 5331, RN3: "Notificação apenas para possibilidades com pelo menos 'X' h
-- de antecedência. - Admin define a antecedência."
--
-- A metade "notificação só com X h" já existia: o varredor calcula
-- `chamado_ate = min(chamado_em + 12h, início da aula − X)`, e quando o prazo
-- já nasce vencido ninguém é chamado. O que faltava era a outra metade — o X
-- estava FIXO em 2 h no código (`ANTECEDENCIA_MINIMA_MS`), e o gestor não tinha
-- como mudá-lo.
--
-- **Só a fila de AULA, e isso não é desta migration: é a D4 da SPEC-064.** A
-- fila de turma não tem "a aula" — o alvo é a turma —, e aplicar a antecedência
-- ali mataria a posição de quem esperava há uma semana por um acidente de
-- relógio. O nome da coluna diz qual fila ela governa, para ninguém ter de ler
-- a D4 para saber.
BEGIN;

-- **Nula, e nulo significa "usa o padrão de 2 h" — nunca "zero".** O mesmo
-- desenho de `reposicoes_por_mes`: nulo é o clube que não configurou, e o
-- comportamento dele tem de ser EXATAMENTE o de antes desta migration.
ALTER TABLE "config_operacao_empresa"
  ADD COLUMN "antecedencia_fila_aula_horas" INTEGER;

-- **Zero não existe** (INV-065). "Chamar com zero hora de antecedência" é
-- chamar alguém para uma aula que está começando — o prazo de confirmar
-- terminaria no instante da própria chamada. Quem quer o mínimo possível manda
-- 1; quem não quer escolher manda nulo.
ALTER TABLE "config_operacao_empresa"
  ADD CONSTRAINT "config_antecedencia_fila_aula_positiva"
    CHECK ("antecedencia_fila_aula_horas" IS NULL OR "antecedencia_fila_aula_horas" >= 1);

COMMIT;
