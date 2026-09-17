-- SPEC-057/TASK-005/D19 — cor de paleta e código único da quadra na agenda.
--
-- **Expansão pura: nenhum binário antigo quebra.** As duas colunas têm valor
-- sem ninguém escrever — `cor` pelo DEFAULT e `codigo_agenda` pela identity —,
-- então o INSERT de antes desta task (que não as conhece) continua válido, e o
-- Back antigo que lê `quadras` simplesmente não as seleciona.
--
-- Rollback é tirar o Admin e depois o Back; **as colunas, a sequence e os
-- dados ficam**. Não reiniciar a sequence em deploy nem em rollback: o código
-- é identidade estável, e reusar um número faria "Q-3" apontar para outra
-- quadra na memória de quem opera a agenda.

-- A cor é AUXILIAR (INV-140): quem identifica a quadra é nome + Q-<código>.
-- Default = primeira cor da paleta; o default não distribui cores, e todas as
-- quadras existentes começam iguais até o gestor escolher.
ALTER TABLE "quadras"
  ADD COLUMN "cor" VARCHAR(7) NOT NULL DEFAULT '#00763A';

-- Mesma lista de `PALETA_DE_QUADRA` (src/courts/paleta-de-quadra.ts), na forma
-- canônica maiúscula. O CHECK não normaliza: quem normaliza é a API, e este
-- CHECK recusa o que passar por fora dela (23514).
ALTER TABLE "quadras"
  ADD CONSTRAINT "quadras_cor_paleta_check"
  CHECK ("cor" IN ('#00763A', '#31658C', '#A23B1E', '#6B46A3', '#8B5E00', '#A12B65'));

-- Identity ALWAYS: o banco gera o número também para as quadras que já
-- existem, e INSERT que tente escrevê-lo é recusado (428C9). Nomes de quadra
-- não são únicos (duas "Quadra 1" na mesma empresa são permitidas); o código
-- é o que desambigua homônimas de mesma cor.
ALTER TABLE "quadras"
  ADD COLUMN "codigo_agenda" INTEGER GENERATED ALWAYS AS IDENTITY;

ALTER TABLE "quadras"
  ADD CONSTRAINT "quadras_codigo_agenda_key" UNIQUE ("codigo_agenda");

ALTER TABLE "quadras"
  ADD CONSTRAINT "quadras_codigo_agenda_positivo" CHECK ("codigo_agenda" > 0);
