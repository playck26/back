-- SPEC-036/TASK-001 — o cadastro completo do aluno.
--
-- ## O GAP-002 fechou aqui
--
-- `TARGET_ARCHITECTURE.md` registrava desde a SPEC-003: *"campos obrigatorios
-- exatos do cadastro de aluno (CPF? data de nascimento?) -- Israel -- NAO
-- [decidido]"*. Ficou aberto seis semanas porque ninguem precisou. Decidido
-- por Israel em 2026-09-09:
--
-- - **sem CPF.** O dinheiro nao passa pela plataforma (o acerto e por fora, o
--   admin so lanca saldo). Documento que nada usa e passivo, nao recurso.
-- - **menor de idade e so informacao** -- nenhum portao novo (LIM-036c).
--
-- ## As colunas vao em `alunos`, e nao em `usuarios` (D1)
--
-- `usuarios` e QUEM ENTRA; `alunos` e a FICHA do aluno no clube. Estas sete
-- em `usuarios` criariam sete colunas nulas em toda conta de gestor e de
-- professor, e um CHECK por papel para defende-las.
--
-- A assimetria que isto cria esta DECLARADA: `telefone` mora em `usuarios` e
-- `emergencia_telefone` vai morar aqui. O `telefone` ja estava no lugar
-- discutivel antes desta spec -- mover e migration de dado com `usuarios`
-- sendo lido por quatro sistemas, e nao e o que o backlog pediu (LIM-036d).
--
-- ## TODAS ANULAVEIS, e e o unico jeito
--
-- Ha alunos em producao. `NOT NULL` sem default quebraria a migration, e
-- `NOT NULL DEFAULT ''` transformaria "nao informado" em "informado vazio" --
-- que e exatamente o que o `alunos_texto_nao_vazio` existe para impedir daqui
-- para frente.
--
-- **Nao ha coluna de completude, e a ausencia e a decisao (D2/INV-111).** A
-- SPEC-037 vai acrescentar plano e contrato a matricula, e no dia em que isso
-- entrar toda percentagem gravada estaria errada -- uma afirmacao sobre um
-- passado que ninguem consegue localizar. Calcular custa zero idas ao banco:
-- a linha ja esta carregada.
ALTER TABLE "alunos"
  ADD COLUMN "data_nascimento"     DATE,
  ADD COLUMN "emergencia_nome"     TEXT,
  ADD COLUMN "emergencia_telefone" TEXT,
  ADD COLUMN "endereco"            TEXT,
  ADD COLUMN "cidade"              TEXT,
  ADD COLUMN "uf"                  CHAR(2),
  ADD COLUMN "observacoes_saude"   TEXT;

-- =========================================================================
-- INV-109 — data de nascimento plausivel
-- =========================================================================
--
-- **`CURRENT_DATE` num CHECK parece defeito e nao e.** O CHECK so roda em
-- INSERT/UPDATE da linha: uma linha gravada hoje continua valida amanha,
-- porque nao ha revalidacao retroativa. Conferido por execucao contra
-- PostgreSQL 18.4 antes de escrever isto -- o Postgres ACEITA a expressao, e
-- `2030-01-01` e recusado nomeando a constraint.
--
-- O piso de 1900 nao e superstição: sem ele, um dedo escorregado em
-- `0202-05-10` passa, e a idade calculada na tela vira 1824 anos.
ALTER TABLE "alunos" ADD CONSTRAINT "alunos_nascimento_plausivel"
  CHECK ("data_nascimento" IS NULL
         OR ("data_nascimento" > DATE '1900-01-01'
             AND "data_nascimento" <= CURRENT_DATE));

-- =========================================================================
-- INV-110 — `uf` e uma das 27
-- =========================================================================
--
-- Duas letras maiusculas NAO bastam: `XX` passaria, e a cidade "Sao
-- Paulo/XX" ninguem consegue filtrar depois. Lista fechada, aqui e na
-- aplicacao -- o banco e a rede de baixo, e a aplicacao da a mensagem.
ALTER TABLE "alunos" ADD CONSTRAINT "alunos_uf_valida"
  CHECK ("uf" IS NULL OR "uf" IN (
    'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
    'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'
  ));

-- =========================================================================
-- INV-108 — ausencia e NULL, e so
-- =========================================================================
--
-- String vazia e ausencia se pareceriam identicas na tela e diferentes na
-- contagem de completude: `''` preencheria o campo sem informar nada, e a
-- barra subiria por engano. `btrim` porque um espaco tem o mesmo efeito.
--
-- Isto NAO impede apagar: `null` apaga, `''` e erro. A distincao esta no
-- AC-005 e existe porque as duas intencoes sao legitimas e diferentes.
ALTER TABLE "alunos" ADD CONSTRAINT "alunos_texto_nao_vazio"
  CHECK (
    ("emergencia_nome"     IS NULL OR btrim("emergencia_nome")     <> '') AND
    ("emergencia_telefone" IS NULL OR btrim("emergencia_telefone") <> '') AND
    ("endereco"            IS NULL OR btrim("endereco")            <> '') AND
    ("cidade"              IS NULL OR btrim("cidade")              <> '') AND
    ("observacoes_saude"   IS NULL OR btrim("observacoes_saude")   <> '')
  );
