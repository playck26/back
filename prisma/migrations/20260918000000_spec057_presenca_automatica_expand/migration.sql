-- SPEC-057/TASK-001 (card 5361) — presença automática: EXPANSÃO, com o job
-- DESLIGADO.
--
-- **Esta migration não liga nada.** A configuração nasce `habilitada = false`,
-- sem ambiente declarado, e a trava de credencial do worker o mantém parado
-- enquanto o Back conectar como dono do schema. A ordem de rollout (spec, D3 e
-- "Rollout e rollback"): schema desativado → Back funcional → Cliente/Admin →
-- provisionamento e troca de credencial → ativação pela função operacional.
--
-- **Binário antigo continua válido sobre este schema.** Ele grava chamada com
-- autor preenchido e sem informar origem: os DEFAULTs dão `legada_humana`, e os
-- CHECKs aceitam. Ele não lê a configuração. O que quebra o leitor antigo é
-- autor NULO (P2032), e autor nulo só nasce do worker — por isso a ativação é o
-- último passo, depois dos leitores novos publicados.

-- =========================================================================
-- D1 — autoria anulável e proveniência nas duas tabelas
-- =========================================================================

ALTER TABLE "chamadas" ALTER COLUMN "registrada_por" DROP NOT NULL;
ALTER TABLE "presencas" ALTER COLUMN "registrado_por" DROP NOT NULL;

-- `legada_humana` para TODA linha que já existe: não se infere o papel de quem
-- registrou pela role atual do usuário (a role muda; o fato não).
ALTER TABLE "chamadas"
  ADD COLUMN "origem" TEXT NOT NULL DEFAULT 'legada_humana',
  ADD COLUMN "origem_inicial" TEXT NOT NULL DEFAULT 'legada_humana',
  -- D5 — o instante do fechamento automático, pelo relógio do BANCO. Ancora
  -- os sete dias de correção, inclusive depois de uma retomada tardia.
  ADD COLUMN "fechada_automaticamente_em" TIMESTAMPTZ NULL;

ALTER TABLE "chamadas" ADD CONSTRAINT "chamadas_origem_dom_check"
  CHECK ("origem" IN ('automatica', 'professor', 'gestor', 'legada_humana'));

ALTER TABLE "chamadas" ADD CONSTRAINT "chamadas_origem_inicial_dom_check"
  CHECK ("origem_inicial" IN ('automatica', 'professor', 'gestor', 'legada_humana'));

-- INV-137: automática ⇒ sem autor; humana ⇒ com autor. Protege o CABEÇALHO; a
-- consistência das linhas de `presencas` é de aplicação (LIM-057j).
ALTER TABLE "chamadas" ADD CONSTRAINT "chamadas_origem_autor_check"
  CHECK (
    ("origem" = 'automatica' AND "registrada_por" IS NULL)
    OR ("origem" <> 'automatica' AND "registrada_por" IS NOT NULL)
  );

-- INV-143: o instante existe exatamente quando a chamada NASCEU automática, e
-- sobrevive à ratificação (que muda `origem`, não `origem_inicial`).
ALTER TABLE "chamadas" ADD CONSTRAINT "chamadas_fechamento_automatico_check"
  CHECK (
    ("origem_inicial" = 'automatica' AND "fechada_automaticamente_em" IS NOT NULL)
    OR ("origem_inicial" <> 'automatica' AND "fechada_automaticamente_em" IS NULL)
  );

-- INV-143: depois de gravado, o instante não muda nem some.
CREATE FUNCTION "chamadas_fechamento_imutavel"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD."fechada_automaticamente_em" IS NOT NULL
     AND NEW."fechada_automaticamente_em" IS DISTINCT FROM OLD."fechada_automaticamente_em" THEN
    RAISE EXCEPTION 'chamadas: fechada_automaticamente_em e imutavel (SPEC-057/INV-143)'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "chamadas_fechamento_imutavel"
  BEFORE UPDATE ON "chamadas"
  FOR EACH ROW EXECUTE FUNCTION "chamadas_fechamento_imutavel"();

-- =========================================================================
-- D3 — autoridade separada: três papéis de grupo
-- =========================================================================
--
-- Papéis são do CLUSTER, não do banco: num servidor com vários bancos (a suíte
-- local) o segundo `migrate deploy` os encontra prontos. Criar só se faltar, e
-- FALHAR se existir com atributo divergente — sem ALTER ROLE silencioso.
DO $$
DECLARE
  nome text;
  r record;
BEGIN
  FOREACH nome IN ARRAY ARRAY['playck_app_runtime', 'presenca_auto_guardiao', 'presenca_auto_operador'] LOOP
    SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = nome;
    IF NOT FOUND THEN
      EXECUTE format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
        nome);
    ELSIF r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls THEN
      RAISE EXCEPTION 'papel % ja existe com atributos divergentes (SPEC-057/D3)', nome;
    END IF;
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA "public" TO "playck_app_runtime", "presenca_auto_guardiao", "presenca_auto_operador";

-- (2) DML das tabelas JÁ EXISTENTES — a configuração ainda não existe, então o
-- runtime nunca tem escrita nela, nem por um instante.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO "playck_app_runtime";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "public" TO "playck_app_runtime";
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON "public"."_prisma_migrations" FROM "playck_app_runtime"';
  END IF;
END $$;

-- =========================================================================
-- D3 — a configuração singleton
-- =========================================================================

CREATE TABLE "public"."config_presenca_automatica" (
  "id" SMALLINT PRIMARY KEY DEFAULT 1,
  "instancia_id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "ambiente" TEXT NULL,
  "ativada_em" TIMESTAMPTZ NULL,
  "habilitada" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "config_presenca_singleton" CHECK ("id" = 1),
  CONSTRAINT "config_presenca_ativa_check"
    CHECK (NOT "habilitada" OR ("ativada_em" IS NOT NULL AND "ambiente" IS NOT NULL)),
  CONSTRAINT "config_presenca_ambiente_formato"
    CHECK ("ambiente" IS NULL OR "ambiente" ~ '^[a-z][a-z0-9_-]{1,31}$')
);

-- (3) o runtime e o operador só LEEM; o guardião muda só a coluna da flag.
REVOKE ALL ON "public"."config_presenca_automatica" FROM PUBLIC, "playck_app_runtime";
GRANT SELECT ON "public"."config_presenca_automatica" TO "playck_app_runtime", "presenca_auto_operador";
GRANT SELECT, UPDATE ("habilitada") ON "public"."config_presenca_automatica" TO "presenca_auto_guardiao";

-- (4) default privileges: só objetos FUTUROS, criados por quem roda as
-- migrations. Tabelas de migrations seguintes nascem com DML para o runtime.
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "playck_app_runtime";
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
  GRANT USAGE, SELECT ON SEQUENCES TO "playck_app_runtime";

-- (5) a guarda da linha.
CREATE FUNCTION "public"."config_presenca_guarda"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'config_presenca_automatica: % recusado (SPEC-057/D3)', TG_OP
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."habilitada" OR NEW."ativada_em" IS NOT NULL OR NEW."ambiente" IS NOT NULL THEN
      RAISE EXCEPTION 'config_presenca_automatica: INSERT so desativado, sem corte e sem ambiente'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."instancia_id" IS DISTINCT FROM OLD."instancia_id" THEN
    RAISE EXCEPTION 'config_presenca_automatica: identidade imutavel' USING ERRCODE = '23514';
  END IF;
  IF NEW."ativada_em" IS DISTINCT FROM OLD."ativada_em" THEN
    RAISE EXCEPTION 'config_presenca_automatica: o corte so e fixado pelo banco' USING ERRCODE = '23514';
  END IF;
  IF OLD."ambiente" IS NOT NULL AND NEW."ambiente" IS DISTINCT FROM OLD."ambiente" THEN
    RAISE EXCEPTION 'config_presenca_automatica: ambiente declarado e imutavel' USING ERRCODE = '23514';
  END IF;
  IF NEW."habilitada" IS DISTINCT FROM OLD."habilitada" THEN
    IF current_user <> 'presenca_auto_guardiao' THEN
      RAISE EXCEPTION 'config_presenca_automatica: habilitada so muda pela funcao operacional'
        USING ERRCODE = '42501';
    END IF;
    IF NEW."habilitada" AND OLD."ativada_em" IS NULL THEN
      NEW."ativada_em" := clock_timestamp();
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "config_presenca_corte_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "public"."config_presenca_automatica"
  FOR EACH ROW EXECUTE FUNCTION "public"."config_presenca_guarda"();

CREATE TRIGGER "config_presenca_truncate_guard"
  BEFORE TRUNCATE ON "public"."config_presenca_automatica"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."config_presenca_guarda"();

-- (6) a função operacional — a ÚNICA porta para ativar ou pausar.
CREATE FUNCTION "public"."presenca_auto_alterar"(p_instancia uuid, p_ambiente text, p_habilitar boolean)
RETURNS TABLE (o_instancia_id uuid, o_ambiente text, o_habilitada boolean, o_ativada_em timestamptz, o_mudou boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r public.config_presenca_automatica%ROWTYPE;
BEGIN
  IF p_instancia IS NULL OR p_ambiente IS NULL OR p_habilitar IS NULL THEN
    RAISE EXCEPTION 'PRESENCA_ARGUMENTO_AUSENTE' USING ERRCODE = 'PA005';
  END IF;
  SELECT * INTO r FROM public.config_presenca_automatica AS c WHERE c.id = 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRESENCA_CONFIG_AUSENTE' USING ERRCODE = 'PA003';
  END IF;
  IF r.instancia_id <> p_instancia THEN
    RAISE EXCEPTION 'PRESENCA_INSTANCIA_DIVERGENTE' USING ERRCODE = 'PA001';
  END IF;
  IF r.ambiente IS NULL THEN
    RAISE EXCEPTION 'PRESENCA_AMBIENTE_NAO_DECLARADO' USING ERRCODE = 'PA004';
  END IF;
  IF r.ambiente <> p_ambiente THEN
    RAISE EXCEPTION 'PRESENCA_AMBIENTE_DIVERGENTE' USING ERRCODE = 'PA002';
  END IF;
  IF r.habilitada IS DISTINCT FROM p_habilitar THEN
    UPDATE public.config_presenca_automatica AS c SET habilitada = p_habilitar
     WHERE c.id = 1 RETURNING c.* INTO r;
    RETURN QUERY SELECT r.instancia_id, r.ambiente, r.habilitada, r.ativada_em, true;
  ELSE
    RETURN QUERY SELECT r.instancia_id, r.ambiente, r.habilitada, r.ativada_em, false;
  END IF;
END $$;

REVOKE ALL ON FUNCTION "public"."presenca_auto_alterar"(uuid, text, boolean) FROM PUBLIC;
-- EXECUTE ao operador ANTES da troca de owner: depois dela o migrador já não é
-- dono e não conseguiria conceder (medido no ensaio da v5).
GRANT EXECUTE ON FUNCTION "public"."presenca_auto_alterar"(uuid, text, boolean) TO "presenca_auto_operador";

-- Trocar o owner exige, do PostgreSQL, que o migrador pertença ao novo owner e
-- que o novo owner possa CREATE no schema. Os dois são concedidos só para a
-- troca e revogados em seguida. (O criador do papel mantém ADMIN OPTION sobre
-- ele no PG16+, e isso é bypass de owner declarado: LIM-057o.)
GRANT "presenca_auto_guardiao" TO CURRENT_USER;
GRANT CREATE ON SCHEMA "public" TO "presenca_auto_guardiao";
ALTER FUNCTION "public"."presenca_auto_alterar"(uuid, text, boolean) OWNER TO "presenca_auto_guardiao";
REVOKE CREATE ON SCHEMA "public" FROM "presenca_auto_guardiao";
REVOKE "presenca_auto_guardiao" FROM CURRENT_USER;

-- (7) a linha, desligada e sem ambiente. O banco gera a instância.
INSERT INTO "public"."config_presenca_automatica" DEFAULT VALUES;
