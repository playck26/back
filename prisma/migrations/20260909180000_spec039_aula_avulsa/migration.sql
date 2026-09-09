-- SPEC-039 — aula avulsa (particular). TASK-001.
--
-- **Uma coluna, uma FK, um CHECK e uma EXCLUDE. Nenhuma tabela nova.**
-- E o tamanho disto é a decisão, não o acaso: ver D1 da spec.
--
-- A leitura natural da demanda ("entidade nova") sugeria `AULA` como terceiro
-- valor de `origem_tipo`. **Duas coisas no banco recusariam isso, e as duas
-- foram lidas antes de escrever esta migration:**
--
--   1. `movimentos_de_credito.ocupacao_origem` é
--      `GENERATED ALWAYS AS (CASE WHEN tipo IN ('consumo','devolucao')
--                                 THEN 'AVULSO'::origem_tipo END) STORED`
--      e a FK de 4 colunas `movimentos_ocupacao_avulsa_fkey` a liga a
--      `ocupacoes_quadra (company_id, id, aluno_id, origem_tipo)`. Um consumo
--      numa ocupação `AULA` teria 'AVULSO' de um lado e 'AULA' do outro:
--      recusado. A INV-097 bloquearia a funcionalidade que a demanda pede.
--   2. `CHECK ocupacoes_valor_por_origem` tem ramo para AVULSO e para TURMA e
--      mais nenhum. Valor sem ramo torna o CHECK falso — toda inserção morreria.
--
-- Reusar `AVULSO` custa esta migration inteira; o outro caminho custaria
-- derrubar e recriar uma coluna GENERATED (reescrita da tabela mais quente do
-- produto) para expressar o que `AVULSO` já expressa.

ALTER TABLE "ocupacoes_quadra"
  ADD COLUMN "professor_id" UUID;

-- FK COMPOSTA (DEF-024), pela mesma razão da SPEC-040: sem `company_id` na
-- chave, a aula de um clube apontaria para a ficha de professor de outro.
--
-- **O alvo `professores (company_id, id)` nasceu ONTEM**, na
-- `20260909120000_spec040_disponibilidade_professor`. Antes dela esta FK
-- morreria com 42830 — é o segundo motivo de a 039 depender da 040, e o
-- primeiro (a janela de atendimento) é o que a spec registra.
--
-- `ON DELETE RESTRICT` de propósito: apagar um professor não pode apagar aulas
-- prestadas e pagas com crédito. **Difere de `disponibilidades_professor`, que
-- é CASCADE** — lá é configuração, aqui é registro de serviço.
ALTER TABLE "ocupacoes_quadra"
  ADD CONSTRAINT "ocupacoes_professor_fkey"
  FOREIGN KEY ("company_id", "professor_id")
  REFERENCES "professores" ("company_id", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- INV-106 — professor só em ocupação AVULSA.
--
-- A ocorrência de turma já sabe quem é o professor **pela turma**, e dois
-- caminhos para o mesmo fato divergem no primeiro dia em que alguém editar um
-- deles. `IS NULL OR` e não `= 'AVULSO'`: a esmagadora maioria das ocupações
-- não tem professor, e um CHECK que as recusasse quebraria o produto inteiro.
ALTER TABLE "ocupacoes_quadra"
  ADD CONSTRAINT "ocupacoes_professor_so_em_avulso"
  CHECK ("professor_id" IS NULL OR "origem_tipo" = 'AVULSO');

-- INV-105 — um professor não está em dois lugares ao mesmo tempo.
--
-- **A trava que a demanda mandou reusar NÃO cobre isto.**
-- `no_overlap_por_quadra` exclui por `quadra_id` e faixa de tempo: duas aulas
-- do MESMO professor, mesmo horário, em quadras DIFERENTES, passariam as duas —
-- e o clube descobriria com o professor em duas quadras ao mesmo tempo.
--
-- Mesmo molde da trava da quadra (`btree_gist` já está instalado desde
-- 20260811000000_courts, que é o que permite `uuid WITH =` num índice GiST).
--
-- **O `IS NOT NULL` é sobre TAMANHO DE ÍNDICE, não sobre correção — e a
-- primeira versão deste comentário dizia o contrário.**
--
-- Eu havia escrito que sem ele "duas reservas comuns de quadras diferentes
-- colidiriam e o produto pararia de funcionar". **Medido no db-spec, e é
-- falso:** numa `EXCLUDE`, NULL nunca é igual a NULL, então a restrição
-- simplesmente não se aplica às linhas sem professor. A sabotagem que eu
-- escrevi para provar a frase ficou VERDE, e foi assim que a frase caiu.
--
-- O `WHERE` continua certo pelo motivo real: ele mantém no índice só as linhas
-- que podem conflitar. Sem ele, todas as ocupações do clube entrariam num
-- índice GiST que nunca as usaria — custo de escrita e de espaço na tabela
-- mais quente do produto, por nada.
--
-- O `status_pagamento <> 'cancelado'` copia a trava da quadra: aula cancelada
-- libera o horário do professor, como cancelamento libera a quadra.
ALTER TABLE "ocupacoes_quadra"
  ADD CONSTRAINT "no_overlap_por_professor"
  EXCLUDE USING gist (
    "professor_id" WITH =,
    tsrange("data" + "hora_inicio", "data" + "hora_fim") WITH &&
  )
  WHERE ("professor_id" IS NOT NULL AND "status_pagamento" <> 'cancelado');
