#!/usr/bin/env bash
# SPEC-077/TASK-006 (SPEC-043/AC-012) — a guarda do job `fit-006`.
#
# Morava inline no `ci.yml`, e por isso nunca teve teste: só se via o que ela
# fazia quando o CI rodava de verdade, e cada uma das quatro combinações de
# ambiente aparece em um tipo de evento diferente. Aqui ela é o mesmo código,
# chamado pelo mesmo passo, e `test/guarda-fit-006.e2e-spec.ts` a roda nas
# quatro.
#
# Uso: guarda-fit-006.sh <comando...>
#   O comando (no CI, `pnpm run test:bucket`) só roda se houver chave.
#
# Entradas, por ambiente — o `ci.yml` as preenche com as expressões do GitHub:
#   SPACES_KEY  o segredo; vazio quando o repositório não o tem ou o evento
#               não o recebe (PR de fork nunca recebe)
#   EVENTO      `github.event_name`
#   REPO_DA_PR  `github.event.pull_request.head.repo.full_name` (vazio fora de PR)
#   REPO        `github.repository`
#
# Saídas:
#   com chave                      → roda o comando, e sai com o código dele
#   sem chave, push                → `::error`, exit 1
#   sem chave, PR do repositório   → `::error`, exit 1
#   sem chave, qualquer outro caso → `::warning`, exit 0 (PR de fork)
set -u

if [ -n "${SPACES_KEY:-}" ]; then
  exec "$@"
fi

# SPEC-043/REQ-007: sem os secrets, o job só pode ficar verde em PR de FORK
# (que nunca os recebe). Em push para `main` ou em PR do próprio repositório,
# secret ausente é configuração quebrada — e um gate que fica verde sem rodar
# foi a causa raiz da SPEC-043.
if [ "${EVENTO:-}" = "push" ] || [ "${REPO_DA_PR:-}" = "${REPO:-}" ]; then
  echo "::error title=FIT-006 não rodou::Os secrets SPACES_* não estão configurados neste repositório. Sem eles as 13 provas contra o bucket real não têm gate — configure os secrets; este job não fica verde sem rodar."
  exit 1
fi
echo "::warning title=FIT-006 não rodou::PR de fork não recebe os secrets SPACES_*; as provas contra o bucket real rodam no merge."
exit 0
