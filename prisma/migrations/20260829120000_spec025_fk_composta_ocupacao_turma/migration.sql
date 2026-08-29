-- SPEC-025 / validacao cruzada, achado 1 (ALTA) — a FK da ocupacao para a
-- turma nao carregava a empresa.
--
-- O QUE ISSO PERMITIA: uma linha de `ocupacoes_quadra` da EMPRESA_B apontando
-- `origem_turma_id` para uma turma da EMPRESA_A. O banco aceitava. E como a
-- media da turma e a lista do gestor agregam POR RELACAO
-- (`avaliacao -> ocupacao -> turma`), uma linha assim faria a EMPRESA_A ver
-- nota — e, na tela do gestor, NOME e COMENTARIO — de aluno da EMPRESA_B.
--
-- Nenhum caminho do produto cria uma linha dessas hoje: `registerClassOccupancy`
-- deriva o `company_id` da propria turma. Mas "nenhum caminho cria" e uma
-- afirmacao sobre o codigo de hoje, e o isolamento entre empresas nao pode
-- depender disso. O projeto ja resolve exatamente este problema em
-- `quadras -> esportes_de_quadra` e `quadras -> categorias_de_quadra`, com FK
-- composta. Esta migration aplica o mesmo padrao.
--
-- **Se a migration abortar, ela achou dado torto** — e ai a mensagem do
-- Postgres nomeia a linha. Abortar e o comportamento certo: seguir em frente
-- deixaria o vazamento de pe.

-- O alvo da FK composta. `id` ja e unico; este indice existe para o
-- `REFERENCES` de duas colunas ter onde se apoiar.
CREATE UNIQUE INDEX "turmas_company_id_id_key" ON "turmas"("company_id", "id");

ALTER TABLE "ocupacoes_quadra" DROP CONSTRAINT "ocupacoes_quadra_origem_turma_id_fkey";

-- MATCH SIMPLE (o padrao) nao exige nada quando `origem_turma_id` e NULL, que
-- e o caso da reserva AVULSA — ela continua valendo sem turma.
ALTER TABLE "ocupacoes_quadra" ADD CONSTRAINT "ocupacoes_quadra_origem_turma_fkey"
    FOREIGN KEY ("company_id", "origem_turma_id") REFERENCES "turmas"("company_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
