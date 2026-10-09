-- SPEC-086/REQ-001 — o mesmo e-mail em mais de uma empresa.
--
-- Antes: `usuarios_email_key`, e-mail único na plataforma inteira (INV-004).
-- Depois, três regras que juntas dizem exatamente:
--
--   | par de contas com o mesmo e-mail                     | resultado  |
--   |------------------------------------------------------|------------|
--   | aluno/professor na empresa A × aluno/professor na B  | permitido  |
--   | qualquer par na MESMA empresa                        | proibido   |
--   | gestor ou super admin × qualquer outra conta         | proibido   |
--
-- Ensaiado na validação da spec: 32 de 32 pares de papel × mesma/outra
-- empresa, nas duas ordens.
--
-- **Sem mexer em dado:** hoje todo e-mail é único, e as três regras novas são
-- mais frouxas que a antiga. Quem impede a repetição enquanto a chave
-- `EMAIL_EM_VARIAS_EMPRESAS` está desligada é a trava por e-mail da aplicação
-- (`src/acesso/trava-de-email.ts`), não o banco.
--
-- **O Prisma não expressa `WHERE` nem `EXCLUDE`:** os itens 3 e 4 NÃO
-- aparecem no `schema.prisma` (mesmo caso dos índices parciais da SPEC-074 e
-- da SPEC-083). Esta migration é a fonte de verdade deles.
--
-- **Rollback:** recriar `usuarios_email_key` só passa com zero e-mails
-- repetidos. Roteiro em `specs/changes/086-*/ROLLBACK.md` (governança).

-- 1. a unicidade global sai
DROP INDEX "usuarios_email_key";

-- 2. único por empresa (super admin tem company_id nulo e não é alcançado)
CREATE UNIQUE INDEX "usuarios_company_id_email_key"
  ON "usuarios" ("company_id", "email");

-- 3. gestor e super admin continuam únicos entre si, na plataforma
CREATE UNIQUE INDEX "usuarios_email_gestao_key"
  ON "usuarios" ("email")
  WHERE "role" IN ('super_admin', 'company_admin');

-- 4. gestor ou super admin × aluno/professor com o mesmo e-mail: proibido.
--    `btree_gist` já está instalado desde a init.
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_email_gestao_excl"
  EXCLUDE USING gist (
    "email" WITH =,
    ("role" IN ('super_admin', 'company_admin')) WITH <>
  );

-- 5. A trava por e-mail (spec, seção "A trava por e-mail"), numa função só,
--    chamada como a PRIMEIRA instrução de toda transação que cria conta
--    (`src/acesso/trava-de-email.ts`).
--
--    - as chaves chegam já ordenadas (`ordenarChavesParaLock`), e o laço as
--      toma nessa ordem: duas transações nunca se cruzam;
--    - UM orçamento para todos os e-mails: `playck.prazo_email` é gravado uma
--      vez, e o `lock_timeout` de cada chave é o RESTO dele, com piso de 1 ms
--      (`lock_timeout = 0` desligaria o teto);
--    - o `lock_timeout` de antes é lido no começo e DEVOLVIDO no fim: o
--      orçamento do e-mail não vale para o resto da transação (DOR-086-R4-01);
--    - devolve, por chave, a ordem e o marcador lido naquele ponto (AC-028).
--
--    Esgotado o prazo, o `55P03` sobe daqui e a aplicação o troca por
--    `EsperaPorEmailEsgotada`.
CREATE FUNCTION "travar_emails_para_criar_conta"(chaves bigint[], prazo_ms integer)
RETURNS TABLE (ordem integer, marcador text)
LANGUAGE plpgsql
AS $$
DECLARE
  anterior text := current_setting('lock_timeout');
  resto_ms bigint;
BEGIN
  PERFORM set_config(
    'playck.prazo_email',
    (clock_timestamp() + make_interval(secs => prazo_ms / 1000.0))::text,
    true
  );
  FOR i IN 1 .. coalesce(array_length(chaves, 1), 0) LOOP
    resto_ms := greatest(
      1,
      floor(extract(epoch FROM (
        current_setting('playck.prazo_email')::timestamptz - clock_timestamp()
      )) * 1000)
    );
    PERFORM set_config('lock_timeout', resto_ms || 'ms', true);
    PERFORM pg_advisory_xact_lock(chaves[i]);
    ordem := i;
    marcador := current_setting('playck.prazo_email');
    RETURN NEXT;
  END LOOP;
  PERFORM set_config('lock_timeout', anterior, true);
END;
$$;
