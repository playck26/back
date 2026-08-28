-- SPEC-024/TASK-001 — termo da plataforma e contrato da empresa.
--
-- Tudo aditivo: nenhuma coluna cai, nenhum dado existente muda de forma.
-- O unico dado escrito e a v1 do termo, no fim.

CREATE TABLE "termos_da_plataforma" (
    "versao"       INTEGER NOT NULL,
    "texto"        TEXT NOT NULL,
    "publicado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "termos_da_plataforma_pkey" PRIMARY KEY ("versao")
);

CREATE TABLE "contratos_da_empresa" (
    "id"           UUID NOT NULL,
    "company_id"   UUID NOT NULL,
    "versao"       INTEGER NOT NULL,
    "texto"        TEXT NOT NULL,
    "publicado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "contratos_da_empresa_pkey" PRIMARY KEY ("id")
);

-- INV-024c: versao publicada nunca e editada; publicar de novo cria versao
-- nova. A unicidade e o que impede duas versoes 3 do mesmo clube.
CREATE UNIQUE INDEX "contratos_da_empresa_company_versao_key"
    ON "contratos_da_empresa"("company_id", "versao");

ALTER TABLE "contratos_da_empresa" ADD CONSTRAINT "contratos_da_empresa_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TYPE "tipo_de_aceite" AS ENUM ('termo', 'contrato');

-- O registro legal. Append-only por regra (INV-024a); a unicidade abaixo e
-- o que torna aceitar duas vezes idempotente em vez de virar duas linhas.
CREATE TABLE "aceites" (
    "id"         UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "tipo"       "tipo_de_aceite" NOT NULL,
    "versao"     INTEGER NOT NULL,
    "aceito_em"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "aceites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "aceites_usuario_tipo_versao_key"
    ON "aceites"("usuario_id", "tipo", "versao");
CREATE INDEX "aceites_usuario_id_idx" ON "aceites"("usuario_id");

ALTER TABLE "aceites" ADD CONSTRAINT "aceites_usuario_id_fkey"
    FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- NULL = o clube nao publicou contrato, e nesse caso so o termo e exigido
-- (REQ-005). E o estado de TODA empresa existente no dia desta migration.
ALTER TABLE "empresas" ADD COLUMN "contrato_versao_vigente" INTEGER;

-- As duas colunas desnormalizadas que o portao le. O historico completo mora
-- em `aceites`; estas respondem "esta em dia?" sem ORDER BY por requisicao.
-- As duas verdades nao divergem porque sao escritas na mesma transacao.
ALTER TABLE "usuarios" ADD COLUMN "termo_versao_aceita" INTEGER;
ALTER TABLE "usuarios" ADD COLUMN "contrato_versao_aceita" INTEGER;

-- A v1 do termo. Sem ela o portao exigiria uma versao que nao existe e
-- bloquearia todo mundo sem saida — falha fechada no pior sentido.
--
-- O texto e deliberadamente curto e verdadeiro sobre o que o produto FAZ
-- hoje. Termo que promete o que o sistema nao cumpre e pior que termo
-- nenhum, porque vira prova contra quem escreveu.
INSERT INTO "termos_da_plataforma" ("versao", "texto") VALUES (1,
'TERMO DE USO — PlayCK

1. O que e este servico
O PlayCK e uma plataforma de gestao de aulas e reservas de quadra, contratada
pelo clube onde voce treina. O clube e responsavel pelas regras da atividade;
a plataforma fornece o sistema.

2. Sua conta
Sua conta e pessoal. Voce e responsavel por manter sua senha em sigilo e por
avisar o clube caso perceba uso indevido.

3. Dados que tratamos
Guardamos os dados que voce ou o clube informam (nome, e-mail, telefone),
seus registros de aula, presenca, reservas e pagamentos, e a data e a versao
dos textos que voce aceita. Usamos esses dados para operar o servico e
disponibiliza-los ao clube ao qual voce esta vinculado.

4. Compartilhamento
Seus dados sao visiveis ao clube ao qual voce pertence. Nao vendemos dados
pessoais.

5. Cancelamento
Voce pode pedir ao clube o encerramento do seu cadastro. Registros
necessarios para obrigacoes legais e contabeis podem ser mantidos pelo prazo
exigido em lei.

6. Alteracoes deste termo
Podemos publicar novas versoes deste termo. Quando isso acontecer, pediremos
seu aceite novamente antes de continuar usando o aplicativo.

Versao 1.');
