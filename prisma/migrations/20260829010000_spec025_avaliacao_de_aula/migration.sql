-- SPEC-025/TASK-001 — avaliacao das AULAS pelo aluno.
--
-- A nota e de UMA AULA (uma ocupacao de origem TURMA). A aula NAO tem media
-- propria: as notas das aulas alimentam a media da TURMA. O objetivo, dito
-- pelo Israel, e "identificar com facilidade os detratores" — e para isso a
-- nota precisa apontar para a aula concreta em que a pessoa se decepcionou,
-- nao para a turma inteira.
--
-- Aditiva: uma tabela nova, nenhuma coluna alterada, nenhum backfill.

CREATE TABLE "avaliacoes_de_aula" (
    "id"          UUID NOT NULL,
    "company_id"  UUID NOT NULL,
    "ocupacao_id" UUID NOT NULL,
    "aluno_id"    UUID NOT NULL,
    "nota"        SMALLINT NOT NULL,
    "comentario"  TEXT,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "avaliacoes_de_aula_pkey" PRIMARY KEY ("id")
);

-- INV-025b — uma avaliacao por aluno por AULA, garantida pelo BANCO e nao so
-- pelo servico. E ela que torna "avaliar de novo" uma CORRECAO em vez de uma
-- segunda linha: o upsert depende desta chave existir.
CREATE UNIQUE INDEX "avaliacoes_de_aula_ocupacao_aluno_key"
    ON "avaliacoes_de_aula"("ocupacao_id", "aluno_id");

-- INV-025c — a nota vive entre 1 e 5. O DTO protege a API; este CHECK protege
-- a TABELA de qualquer outro caminho (seed, script, migration futura).
ALTER TABLE "avaliacoes_de_aula" ADD CONSTRAINT "avaliacoes_de_aula_nota_check"
    CHECK ("nota" >= 1 AND "nota" <= 5);

ALTER TABLE "avaliacoes_de_aula" ADD CONSTRAINT "avaliacoes_de_aula_comentario_check"
    CHECK ("comentario" IS NULL OR length("comentario") <= 500);

CREATE INDEX "avaliacoes_de_aula_ocupacao_id_idx" ON "avaliacoes_de_aula"("ocupacao_id");
CREATE INDEX "avaliacoes_de_aula_company_id_idx" ON "avaliacoes_de_aula"("company_id");
-- A media da turma agrega por este caminho (avaliacao -> ocupacao -> turma),
-- e o gestor lista por turma. Sem indice, a lista de uma turma movimentada
-- varre a tabela inteira.
CREATE INDEX "avaliacoes_de_aula_aluno_id_idx" ON "avaliacoes_de_aula"("aluno_id");

-- CASCADE: a nota nao tem sobre o que falar sem a aula ou sem o aluno.
-- Diferente dos `aceites` da SPEC-024, que usam RESTRICT porque sao registro
-- legal — avaliacao nao e prova de nada juridico.
ALTER TABLE "avaliacoes_de_aula" ADD CONSTRAINT "avaliacoes_de_aula_ocupacao_fkey"
    FOREIGN KEY ("ocupacao_id") REFERENCES "ocupacoes_quadra"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "avaliacoes_de_aula" ADD CONSTRAINT "avaliacoes_de_aula_aluno_fkey"
    FOREIGN KEY ("aluno_id") REFERENCES "alunos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "avaliacoes_de_aula" ADD CONSTRAINT "avaliacoes_de_aula_company_fkey"
    FOREIGN KEY ("company_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
