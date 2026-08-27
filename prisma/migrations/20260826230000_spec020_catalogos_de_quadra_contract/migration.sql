-- SPEC-020/TASK-004 — a fase CONTRACT.
--
-- A expand (20260826190236) criou o catalogo, ligou as quadras e deixou as
-- colunas de texto de pe. Esta migration fecha o ciclo: `esporte_id` vira
-- obrigatoria e as duas colunas de texto saem.
--
-- DERRUBAR COLUNA E IRREVERSIVEL. O `down` nao existe no Prisma, e mesmo que
-- existisse ele nao traria o dado de volta. Por isso a primeira coisa que
-- acontece aqui e uma pergunta ao banco, nao uma escrita.

-- ---------------------------------------------------------------------------
-- 1. A pergunta que precisa ser feita ANTES de qualquer coisa
-- ---------------------------------------------------------------------------
--
-- A migration de expand levantou este caso e o deixou registrado como
-- `RAISE NOTICE`: quadra cujo `esporte` era texto EM BRANCO nao tinha como
-- ser catalogada, e ficou com `esporte_id` nulo. Ela nao impedia a expand;
-- impede a contract.
--
-- Se existir alguma, esta migration ABORTA e o deploy falha — o container
-- nao sobe, e o DigitalOcean mantem a versao anterior ATIVA. Producao
-- continua no ar com o codigo velho. E a direcao segura de falhar: o
-- contrario seria uma quadra sem esporte numa coluna NOT NULL, ou pior,
-- apagar a unica informacao que permitiria consertar.
--
-- Para destravar: abrir o Admin, editar a quadra apontada e escolher um
-- esporte. Depois empurrar de novo.
DO $$
DECLARE
  sem_esporte integer;
  exemplos text;
BEGIN
  SELECT count(*) INTO sem_esporte FROM quadras WHERE esporte_id IS NULL;

  IF sem_esporte > 0 THEN
    -- O nome da quadra vai na mensagem de proposito: "3 quadras sem esporte"
    -- manda alguem procurar; o nome manda alguem consertar.
    SELECT string_agg(nome, ', ') INTO exemplos
    FROM (
      SELECT nome FROM quadras WHERE esporte_id IS NULL ORDER BY nome LIMIT 10
    ) AS amostra;

    RAISE EXCEPTION
      'SPEC-020/TASK-004: % quadra(s) sem esporte_id — a contract nao pode rodar. Quadras: %. Escolha um esporte para cada uma no Admin e empurre de novo.',
      sem_esporte, exemplos;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. `esporte_id` vira obrigatoria
-- ---------------------------------------------------------------------------
--
-- A partir daqui e o BANCO que garante a INV-054 por inteiro: nao existe
-- quadra sem esporte, e o esporte e sempre da propria empresa (a FK composta
-- `quadras_esporte_fkey`, criada na expand, cuida da segunda metade).
--
-- Isto e prova por violacao de verdade: nao ha caminho de codigo que crie
-- quadra sem esporte, porque o banco recusa.
ALTER TABLE "quadras" ALTER COLUMN "esporte_id" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. As colunas de texto saem
-- ---------------------------------------------------------------------------
--
-- `quadras.esporte` era a origem do defeito que criou esta spec: texto livre
-- digitado no Admin, e a barra de filtro do app do aluno montada com
-- `new Set(quadras.map(q => q.esporte))`. "Tenis" e "tenis" eram dois
-- filtros.
ALTER TABLE "quadras" DROP COLUMN "esporte";

-- `empresas.esportes` era a segunda lista que nao falava com a primeira
-- (INV-057). O clube nascia com ela preenchida pelo SAdmin e com o catalogo
-- vazio; o gestor tinha de cadastrar tudo de novo. A TASK-008 fez o campo do
-- SAdmin semear o catalogo, e e por isso que esta coluna pode sair agora —
-- **a resposta da API continua tendo `esportes: string[]`**, so que derivado.
ALTER TABLE "empresas" DROP COLUMN "esportes";
