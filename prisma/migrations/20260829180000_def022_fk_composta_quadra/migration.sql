-- DEF-022 / validacao cruzada da SPEC-026, achado 3 (ALTA) — as FKs que
-- apontam para `quadras` nao carregavam a empresa.
--
-- O QUE ISSO PERMITIA: uma linha de `ocupacoes_quadra` com `company_id = A`
-- apontando `quadra_id` para uma quadra da EMPRESA_B. O banco aceitava, e o
-- detalhe do dia do professor devolveria `quadraNome` da outra empresa. O
-- mesmo valia para `turmas` e para `horarios_funcionamento`.
--
-- E EXATAMENTE o achado da SPEC-025, uma tabela ao lado. Aquela migration
-- (20260829120000) fechou `ocupacoes_quadra -> turmas` e parou ali, porque
-- era so ali que a validacao daquele ciclo tinha olhado. Corrigir onde se
-- esta olhando, em vez de onde o defeito mora, e o padrao que este projeto ja
-- pagou tres vezes — por isso aqui vao as TRES tabelas que referenciam
-- quadra, e nao so a que foi apontada.
--
-- Nenhum caminho do produto cria uma linha dessas: todos derivam o
-- `company_id` do token. Mas "nenhum caminho cria" e afirmacao sobre o codigo
-- de hoje, e o isolamento entre empresas nao pode depender disso — foi
-- confiar nisso que produziu o achado da SPEC-025.
--
-- **Se a migration abortar, ela achou dado torto**, e a mensagem do Postgres
-- nomeia a linha. Abortar e o comportamento certo: seguir em frente deixaria
-- o vazamento de pe.

-- O alvo das tres FKs. `id` ja e PK; este indice existe para o `REFERENCES`
-- de duas colunas ter onde se apoiar. Mesmo papel do
-- `turmas_company_id_id_key` da migration anterior.
CREATE UNIQUE INDEX "quadras_company_id_id_key" ON "quadras"("company_id", "id");

-- 1. ocupacoes_quadra -> quadras
ALTER TABLE "ocupacoes_quadra" DROP CONSTRAINT "ocupacoes_quadra_quadra_id_fkey";
ALTER TABLE "ocupacoes_quadra" ADD CONSTRAINT "ocupacoes_quadra_quadra_fkey"
    FOREIGN KEY ("company_id", "quadra_id") REFERENCES "quadras"("company_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. turmas -> quadras
ALTER TABLE "turmas" DROP CONSTRAINT "turmas_quadra_id_fkey";
ALTER TABLE "turmas" ADD CONSTRAINT "turmas_quadra_fkey"
    FOREIGN KEY ("company_id", "quadra_id") REFERENCES "quadras"("company_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. horarios_funcionamento -> quadras
--
-- `quadra_id` aqui e NULAVEL de proposito: a linha sem quadra e o horario da
-- EMPRESA INTEIRA (SPEC-010). MATCH SIMPLE — o padrao do Postgres — nao
-- dispara a checagem quando qualquer coluna da chave e nula, entao essas
-- linhas continuam valendo exatamente como antes. `CASCADE` preservado:
-- apagar a quadra apaga o horario dela.
ALTER TABLE "horarios_funcionamento" DROP CONSTRAINT "horarios_funcionamento_quadra_id_fkey";
ALTER TABLE "horarios_funcionamento" ADD CONSTRAINT "horarios_funcionamento_quadra_fkey"
    FOREIGN KEY ("company_id", "quadra_id") REFERENCES "quadras"("company_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;
