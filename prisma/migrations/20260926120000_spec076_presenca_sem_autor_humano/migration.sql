-- SPEC-076/D10 — o banco recusa presenca com autor humano (INV-076a).
--
-- Decisoes 1 e 9 do Israel: ninguem grava presenca a mao, nem o professor
-- nem o gestor. A rota que gravava (`PUT /me/teacher/attendance/:id`) saiu do
-- codigo; estes dois gatilhos fazem a mesma regra valer no banco, para
-- qualquer caminho — um escritor novo, um delegate recebido por parametro,
-- SQL montado em pedacos.
--
-- O que eles garantem, e o que NAO (LIM-076a): nenhuma presenca nova ou
-- alterada tem autor humano, e nenhum cabecalho `completa` novo ou alterado
-- tem origem humana. Um escritor que grave presenca SEM autor e, para o banco,
-- indistinguivel do fechamento automatico, e passa.
--
-- Quem continua passando (autor nulo): o worker, o refechamento do "Desfazer"
-- do `nao_houve` (D3, que grava `completa` + `automatica` num UPDATE so) e a
-- correcao das chamadas do periodo (D9). O `registrarNaoHouve` grava
-- `nao_houve`, nao `completa`. `DELETE` nao e afetado.
--
-- Consequencia (LIM-076e): linha legada com autor fica imutavel — qualquer
-- UPDATE dela mantem o autor e e recusado. Nenhum caminho de produto as
-- atualiza depois da D1.
--
-- A VALVULA e a mesma da SPEC-032 (`append_only_com_valvula_de_teste`): o GUC
-- de transacao E a role de limpeza, que so existe no banco de testes — e e
-- por ela que os db-specs semeiam chamada humana LEGADA. Sem a role, a
-- valvula nao abre em producao.
--
-- O rollback esta pronto e fora de `prisma/migrations`:
-- `prisma/rollback/076-presenca-sem-autor-humano.sql` (AC-034).

CREATE FUNCTION "presenca_sem_autor_humano"() RETURNS trigger AS $$
BEGIN
  IF NEW.registrado_por IS NULL THEN
    RETURN NEW;
  END IF;
  IF coalesce(current_setting('playck.limpeza_append_only', true), '') = 'on'
     AND current_user = 'playck_test_cleanup' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'presenca com autor humano: ninguem grava presenca a mao (SPEC-076/INV-076a)'
    USING ERRCODE = '23514';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "presencas_sem_autor_humano"
  BEFORE INSERT OR UPDATE ON "presencas"
  FOR EACH ROW EXECUTE FUNCTION "presenca_sem_autor_humano"();

CREATE FUNCTION "chamada_completa_so_automatica"() RETURNS trigger AS $$
BEGIN
  IF NEW.completude <> 'completa' OR NEW.origem = 'automatica' THEN
    RETURN NEW;
  END IF;
  IF coalesce(current_setting('playck.limpeza_append_only', true), '') = 'on'
     AND current_user = 'playck_test_cleanup' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'chamada completa com origem humana: so o fechamento automatico fecha chamada (SPEC-076/INV-076a)'
    USING ERRCODE = '23514';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "chamadas_completa_so_automatica"
  BEFORE INSERT OR UPDATE ON "chamadas"
  FOR EACH ROW EXECUTE FUNCTION "chamada_completa_so_automatica"();
