-- SPEC-079/D2 — migracao A: so DADOS. Toda empresa tem nivel, e toda turma
-- sem nivel recebe o PRIMEIRO nivel da sua empresa (decisoes I1 a I3 do
-- Israel, 2026-09-28). A coluna continua anulavel: o `SET NOT NULL` e da
-- migracao B, que so vem num merge depois do portao G1.
--
-- **Vai a producao no merge**, no boot da instancia nova
-- (`db:migrate:deploy && start:prod`), COM A INSTANCIA ANTIGA ATENDENDO. Por
-- isso a trava: escrever nivel e mudar o nivel de turma sao os gestos que a
-- INV-075h da SPEC-075 protege (edicao de nivel e criacao de matricula da
-- mesma empresa nunca correm juntas). Antes de tocar em `niveis` ou `turmas`
-- de uma empresa, esta migracao toma `pg_advisory_xact_lock` com a MESMA
-- chave do `travarNivelDaEmpresa`:
--
--   ChaveDeLock.deTexto('nivel-da-empresa:' + id)
--   = sha256 do UTF-8, os 8 primeiros bytes, big-endian, com sinal
--   = ('x' || substr(encode(sha256(convert_to(..., 'UTF8')), 'hex'), 1, 16))::bit(64)::bigint
--
-- A igualdade das duas e provada no banco (AC-018, `spec-079-passagem`).
--
-- **Um bloco DO so**: a trava de transacao vale ate o fim da instrucao, e as
-- empresas sao percorridas em ordem de `id` — a mesma ordem para todo mundo
-- que toma mais de uma. As duas condicoes (empresa sem nivel, turma sem
-- nivel) sao REVISTAS depois da trava: quem estava na fila pode ter criado um
-- nivel ou uma turma enquanto esperavamos.
--
-- Idempotente (AC-010): rodada de novo, nao acha empresa sem nivel nem turma
-- sem nivel, e nao escreve nada. Nao toca em empresa que ja tem nivel nem em
-- turma que ja tem nivel.
--
-- Os tres niveis sao os de `NIVEIS_PADRAO` (`src/people/nivel-efetivo.ts`),
-- com os mesmos nomes e ordens; um teste le este arquivo e compara (AC-008).
-- O "primeiro nivel" e o da INV-075c: menor `ordem`, depois `created_at`,
-- depois `id` — a ordem de `nivelEfetivo`.
DO $$
DECLARE
  empresa RECORD;
BEGIN
  FOR empresa IN
    SELECT e.id
      FROM empresas e
     WHERE NOT EXISTS (SELECT 1 FROM niveis n WHERE n.company_id = e.id)
        OR EXISTS (SELECT 1 FROM turmas t WHERE t.company_id = e.id AND t.nivel_id IS NULL)
     ORDER BY e.id
  LOOP
    PERFORM pg_advisory_xact_lock(
      ('x' || substr(encode(sha256(convert_to('nivel-da-empresa:' || empresa.id::text, 'UTF8')), 'hex'), 1, 16))::bit(64)::bigint
    );

    INSERT INTO "niveis" ("id", "company_id", "nome", "ordem")
    SELECT gen_random_uuid(), empresa.id, padrao.nome, padrao.ordem
      FROM (VALUES ('Iniciante', 1), ('Intermediário', 2), ('Avançado', 3)) AS padrao (nome, ordem)
     WHERE NOT EXISTS (SELECT 1 FROM niveis n WHERE n.company_id = empresa.id);

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
END $$;
