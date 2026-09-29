-- SPEC-079/D2 — migracao B: toda turma tem nivel, e o BANCO passa a garantir
-- (`turmas.nivel_id NOT NULL`, sem valor padrao automatico — D1).
--
-- **So entra depois do portao G1** (rollout da spec): o Back A no ar — o que
-- valida `nivelId` na API — e, em producao, nenhuma turma sem nivel numa
-- empresa sem nivel (`bloqueiam_b = 0`). Vai a producao no merge, no boot da
-- instancia nova, e a instancia antiga que atende durante a troca e o Back A:
-- a aba antiga do Admin recebe `400`, nunca `500` (AC-012).
--
-- Primeiro REPETE a atribuicao da migracao A, para a turma criada durante a
-- troca do M2 (a instancia antiga, o Back 0, ainda aceitava turma sem nivel).
-- Com a mesma trava de nivel da empresa, antes de tocar em `turmas` de cada uma
-- (a INV-075h; a chave e a do `travarNivelDaEmpresa`, provada igual no AC-018).
--
-- **Nao semeia nivel.** Turma sem nivel numa empresa sem nivel nao tem a quem
-- receber, fica nula, e o `SET NOT NULL` ABORTA a migracao — o deploy nao sobe
-- e a instancia antiga continua. E o unico caso que aborta, e e o que o G1
-- conta antes do merge.
--
-- Tudo num bloco DO so: as travas valem ate o `SET NOT NULL` terminar.
DO $$
DECLARE
  empresa RECORD;
BEGIN
  FOR empresa IN
    SELECT DISTINCT t.company_id AS id
      FROM turmas t
     WHERE t.nivel_id IS NULL
     ORDER BY t.company_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      ('x' || substr(encode(sha256(convert_to('nivel-da-empresa:' || empresa.id::text, 'UTF8')), 'hex'), 1, 16))::bit(64)::bigint
    );

    UPDATE "turmas" SET "nivel_id" = (
      SELECT n.id
        FROM niveis n
       WHERE n.company_id = empresa.id
       ORDER BY n.ordem, n.created_at, n.id
       LIMIT 1
    )
     WHERE company_id = empresa.id
       AND nivel_id IS NULL;
  END LOOP;

  ALTER TABLE "turmas" ALTER COLUMN "nivel_id" SET NOT NULL;
END $$;
