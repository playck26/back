# ARCHITECTURE — `back` (PlayCK)

**Fonte: análise direta do código.** Data: 2026-08-24.
**Commit de referência:** a **SPEC-017 completa** (TASK-001 a 007),
2026-08-24/25, a partir de `f75615b`. Por nome e não por hash
porque este arquivo faz parte do próprio commit — um documento não consegue
citar o hash que ele ajuda a formar.

Esta é a planta **AS-IS**: descreve o que existe. Intenção arquitetural vive
em `TARGET_ARCHITECTURE.md` (raiz do workspace) + ADRs em `DECISIONS.md`.
Divergência entre este documento e o código é defeito **deste documento**.

---

## 1. Stack real

Do `package.json` (produção):

| Lib | Versão | Papel |
|---|---|---|
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | ^3.1116 | storage de objeto (Spaces, ADR-015) — **só o adaptador importa** |
| `@nestjs/core`, `common`, `platform-express` | ^11.0.1 | framework HTTP |
| `@nestjs/config` | ^4.0.4 | env |
| `@nestjs/jwt`, `@nestjs/passport`, `passport`, `passport-jwt` | ^11 / ^0.7 / ^4 | autenticação |
| `@nestjs/swagger` | ^11.4.6 | gera `openapi.json` |
| `@nestjs/throttler` | ^6.5.0 | rate limit |
| `@prisma/client` | ^6.19.3 | acesso a dados |
| `bcrypt` | ^6.0.0 | hash de senha |
| `class-validator`, `class-transformer` | ^0.15 / ^0.5 | validação de DTO |
| `cookie-parser` | ^1.4.7 | cookie de refresh |
| `helmet` | ^8.3.0 | cabeçalhos de segurança |

**Banco:** PostgreSQL **18.6** (Neon, `aws-sa-east-1`), verificado em
2026-08-22.

**NÃO existem no projeto** (docs antigos ou suposições comuns podem citar):
Turborepo ou qualquer monorepo (ADR-001 é poly-repo), Redis, GraphQL, ORM
além do Prisma, provedor de e-mail, gateway de pagamento, WebSocket.

**Storage de arquivo passou a existir em 2026-08-24** (SPEC-017) e é o único
item que saiu desta lista. Existem, das TASK-001/002/002b/003/004: a porta `StorageProvider`, o
adaptador S3, a config das seis variáveis `SPACES_*`, o **validador de
WebP**, a **gramática da chave**, o **`StorageService`** (que impõe a
INV-037: nunca assina chave crua), a **fonte única da configuração de
upload** (`@UploadDeMidia()`, INV-048) e a **tabela** da fila de exclusão.

Existem também: a **fila**, o **worker**, o advisory lock por chave, a porta
`KeyReferenceChecker` (TASK-005), o **limite por usuário** e o **medidor de
bucket** (TASK-006), e o **FIT-006** contra o bucket real (TASK-007).

**O limite conta por usuário porque o guard confere o Bearer token ele
mesmo** — não porque lê `request.user`. Ler `request.user` foi a primeira
versão e **não funcionava**: `APP_GUARD` roda antes do `JwtAuthGuard` de
rota, e naquele instante não há usuário. Quem mexer aqui precisa saber
disso, porque a versão errada compila, passa no unitário e cai no IP em
silêncio.

**O que NÃO existe, e a lista importa mais que o que existe:** **nenhuma
rota de upload do produto**, nenhuma coluna de mídia, e **nenhum
`KeyReferenceChecker` registrado** — sem ele o worker é fail-closed e não
apaga nada. A tabela da fila está criada e **vazia**, porque quem enfileira é
quem apaga referência, e isso é da SPEC-018. **A SPEC-017 está completa**;
falta a SPEC-018 inteira.

**Ler `storage/` esperando upload funcionando é ler errado**, e ler o worker
esperando que ele apague alguma coisa hoje também.

**O contrato de upload é exercitado por um controller que mora em `test/`**
(`test/storage/fixture-upload.controller.ts`), e é decisão da spec: rota
temporária em produção nunca é temporária, e uma que aceita upload sem dono é
superfície de ataque esperando uso. O que é real ali é o interceptor, o
validador e o `StorageService` — a configuração vem da **mesma** fonte que as
rotas da SPEC-018 vão usar.

**`fila/worker` saiu da lista em 2026-08-24** (TASK-005). Existe uma fila
(`arquivos_pendentes_exclusao`) e um worker que roda por `setInterval` — **não
há Redis, não há broker, não há job queue de biblioteca**. A serialização é
`pg_try_advisory_xact_lock`, e o agendamento é um temporizador. Quem procurar
BullMQ ou Redis aqui não vai achar, e é decisão: o projeto não tem nenhum
outro job agendado.

**E o worker está fail-closed:** sem `KeyReferenceChecker` registrado — que é
da SPEC-018 — ele **não apaga nada**. Rodando hoje, ele não faz nada visível,
e isso é o estado esperado.

## 2. Visão geral e fluxo de referência

```
HTTP → Controller (guards + DTO)
         → Service do módulo dono
             → PrismaService
                 → PostgreSQL (constraints são a garantia final)
```

**Fluxo de referência — criar reserva** (`POST /api/v1/bookings`), o molde
a replicar:

1. `courts/bookings.controller.ts` — `@UseGuards(JwtAuthGuard, RolesGuard)`,
   resolve `alunoId` a partir do token quando quem chama é `aluno`
   (**nunca** do corpo);
2. `dto/create-booking.dto.ts` — `class-validator` valida formato; aceita o
   formato novo (`slots[]`) e o de transição (`horaInicio`/`horaFim`);
3. `courts/courts.service.ts::createBooking` — ordem fixa: normalizar →
   recusar duplicado/sobreposto → agrupar contíguos (`slots.util.ts`) →
   limite de 6h → INV-011 (expediente, via `HorarioFuncionamentoService`) →
   pré-checar INV-001 → inserir em `$transaction`;
4. o banco decide: constraint `EXCLUDE` (INV-001) é a **garantia final**; a
   pré-checagem existe só para a resposta dizer **qual bloco** falhou.

## 3. Modelo de domínio

**17 tabelas e 10 enums** no `schema.prisma` (conferido em 2026-08-24, depois da SPEC-017:TASK-004).

| Tabela | Dono | Papel / quirk |
|---|---|---|
| `empresas` | MOD-002 | tenant. `slug` único alimenta o link público de cadastro; `permite_auto_cadastro` liga/desliga esse link |
| `usuarios` | MOD-001 | identidade. E-mail único **global** (INV-004). `senha_temporaria` tranca a conta até a troca (INV-008) |
| `refresh_tokens` | MOD-001 | rotação por claim atômica; reuso revoga a sessão inteira |
| `convites_aluno` | MOD-001 | `token_hash` é **sha256 determinístico**, não bcrypt — o token é a chave de busca da claim atômica (INV-009) |
| `pedidos_reserva` | MOD-005 | idempotência **do pedido**, com fingerprint do payload |
| `alunos` | MOD-003 | `status` (ativo/inativo) ≠ `vinculo` (pendente/aprovado/recusado). O segundo é INV-010 |
| `professores` | MOD-003 | `usuario_id` **anulável e único** (INV-014). Nulo é o estado normal: ficha sem acesso. `ON DELETE SET NULL` — apagar a conta não apaga o histórico de turmas |
| `niveis` | MOD-003 | único por `(company_id, nome)` |
| `quadras` | MOD-005 | `preco_hora` é o preço **atual**; o cobrado fica em `ocupacoes_quadra.valor` |
| `ocupacoes_quadra` | MOD-005 | **linha do tempo da quadra**. `origem_tipo` AVULSO/TURMA. Ocupação de turma **não tem `aluno_id`** — origem do GAP-008 |
| `horarios_funcionamento` | MOD-005 | `quadra_id` nulo = padrão da empresa. Herança é **ausência de registro**, não cópia |
| `turmas`, `turma_alunos` | MOD-004 | recorrência semanal; gera ocupações numa janela de 8 semanas. **`turma_alunos` não tem vigência temporal** — a linha some quando o aluno sai (origem de LIM-003) |
| `presencas` | MOD-004 | o par (ocorrência, aluno). `origem_tipo` é coluna **constante** que participa de FK composta para `ocupacoes_quadra(id, origem_tipo)`: é assim que INV-016 é imposta pelo banco, não por código |
| `chamadas` | MOD-004 | **cabeçalho da chamada** (SPEC-015/INV-027), uma linha por ocorrência lançada. `completude` = `completa` \| `desconhecida`: `presencas` sozinha não distingue "completa de uma turma de 2" de "pela metade de uma turma de 10", e era daí que vinha a DEF-002. `desconhecida` marca o que foi gravado antes da correção |
| `config_pagamento_empresa` | MOD-006 | link/WhatsApp por empresa; `company_id` único |
| `arquivos_pendentes_exclusao` | MOD-008 | fila de exclusão de objeto de storage (SPEC-017). **A única tabela sem FK para `empresas`** — precisa sobreviver à exclusão da empresa, que é justamente quando há mais objeto para apagar. `company_id` é amarrado à `key` por CHECK. **Vazia: nada escreve nela até a SPEC-018**, que é quem apaga referência |

**Constraints que o Prisma não expressa** (escritas à mão nas migrations, e
que são a garantia real):

| Constraint | Garante |
|---|---|
| `EXCLUDE USING gist ... WHERE status_pagamento <> 'cancelado'` | INV-001: sem overbooking; e cancelar **libera** o slot |
| `UNIQUE NULLS NOT DISTINCT (company_id, quadra_id, dia_semana)` | um único horário padrão por dia (PG 15+) |
| `horarios_coerencia_fechado`, `horarios_hora_cheia` | dia fechado sem horas; horário só em `HH:00` |
| `ocupacoes_valor_por_origem` | `valor` obrigatório em AVULSO, **nulo** em TURMA |
| `ux_ocupacoes_quadra_client_request_id` (parcial) | idempotência anterior à SPEC-011, ainda válida para linhas antigas |
| `chamadas_origem_tipo_check` + FK composta | cabeçalho de chamada só existe para aula de turma — mesma construção de `presencas` |
| `chamadas_completude_esperados_check` | `completa` exige `esperados > 0`; `desconhecida` exige `esperados` nulo. Amarra os dois sentidos: afirmação sem lastro e lastro sem afirmação são igualmente recusados |
| `presencas_chamada_fkey` (`ON DELETE NO ACTION`) | presença sem cabeçalho é impossível — INV-027 imposta pelo banco. `NO ACTION` e não `RESTRICT` porque apagar a ocorrência cascateia para as duas tabelas na mesma instrução; `RESTRICT` é checado na hora e abortaria |
| `arquivos_pendentes_key_da_empresa_check` | INV-030 no banco: `key LIKE 'empresas/%'` e `split_part(key,'/',2) = company_id::text`. É o que substitui a FK que esta tabela não pode ter |
| `arquivos_pendentes_erro_com_tentativa_check`, `..._lock_com_conflito_check` | erro sem tentativa é afirmação sem lastro; contador de lock e data do conflito existem ou não existem juntos |

## 4. Estrutura de pastas

```
src/
  auth/            MOD-001 — login, sessão, convites, troca de senha
  companies/       MOD-002 — tenants (+ rota pública por slug)
  people/          MOD-003 — alunos, professores, níveis
  classes/         MOD-004 — turmas
  courts/          MOD-005 — quadras, ocupações, horários, agenda
  payment-config/  MOD-006 — meio de pagamento e status
  frequencia/      SPEC-015 — relatórios de frequência (sem MOD próprio)
  dashboard/       MOD-007 — agregações de leitura
  storage/         MOD-008 — porta, adaptador S3, validador WebP, gramática
                   da chave, StorageService, fonte única do upload, fila,
                   worker, advisory lock, limite de abuso e medidor de
                   bucket (SPEC-017). **Sem controller**
  common/          guards, decorators, utils, tipos, smoke
  prisma/          PrismaService (@Global)
```

**Padrão interno de módulo:** `*.module.ts`, `*.controller.ts`,
`*.service.ts`, `*.service.spec.ts`, `dto/`. Serviço que virou fonte de
verdade transversal ganha arquivo próprio (`horario-funcionamento.service.ts`,
`agenda.service.ts`, `slots.util.ts`).

**`frequencia/` não tem controller nem MOD próprio**, e é o único assim.
(`storage/` também não tem controller, mas tem MOD — e por decisão da
SPEC-017: a rota que exercita o serviço é um controller de teste, fora do
`AppModule`, na TASK-002b. Rota de upload temporária em produção é
superfície de ataque esperando uso.) O
serviço é consumido por `ClassesModule` (relatório da turma) e por
`PeopleModule` (relatório do aluno), e `ClassesModule` já importa
`PeopleModule` — deixá-lo em qualquer um dos dois fecharia ciclo.
`forwardRef` resolveria e esconderia o problema: ele depende só do Prisma e
não pertence a nenhum dos dois.

**`courts/` concentra 4 controllers** (courts, bookings, company-settings,
agenda) porque MOD-005 é dono da linha do tempo da quadra e tudo ali a toca.
É o maior módulo do projeto — ver Gaps.

## 5. Contratos de API

**50 caminhos, 70 operações HTTP** (conferido em 2026-08-23 contra o
`openapi.json`, depois da DEF-003, da DEF-004 e da SPEC-016). As duas medidas aparecem porque "rotas" é ambíguo: a
versão anterior desta planta dizia "41 rotas" contando caminhos, e trocar
a métrica em silêncio faria o número parecer um salto de escopo.

A fonte é o `openapi.json` **gerado do código**, com gate de CI
(`git diff --exit-code openapi.json`) que falha se ele ficar stale —
verificado funcionando: o arquivo commitado estava em dia. `API_CONTRACTS.md` (raiz) descreve as regras
de negócio por contrato; este documento não as duplica.

Convenções observadas: prefixo global `api/v1`; datas como `YYYY-MM-DD` e
horas como `HH:mm` em texto (colunas `@db.Date`/`@db.Time`, base 1970 para
hora); erros de domínio trazem `code` estável (`FORA_DO_EXPEDIENTE`,
`SENHA_TEMPORARIA`, `VINCULO_PENDENTE`, `IDEMPOTENCY_KEY_REUSED`,
`RESERVA_CANCELADA`, `OCUPACAO_DE_TURMA`).

## 6. Autenticação e autorização

- **Access token** JWT (~15 min) no header; **refresh token** em cookie
  `httpOnly`, `SameSite=Strict`, path `/api/v1/auth`, rotacionado a cada uso.
- **`JwtAuthGuard` faz duas coisas**: autentica **e** aplica INV-008 (conta
  com senha temporária só alcança trocar senha, `/auth/me` e logout). A trava
  mora aqui, e não num `APP_GUARD`, porque guard global roda antes do guard de
  rota — quando `request.user` ainda não existe.
- Papéis: `super_admin` (só `/companies`), `company_admin`, `aluno`,
  `professor` (SPEC-013 — só leitura, e só das próprias turmas: INV-012).
- `usuarios.status = 'inativo'` recusa login, refresh e toda rota
  autenticada (INV-013). A checagem roda **antes** do atalho de
  `@PermiteSenhaTemporaria`, senão a conta inativa trocaria a senha e
  voltaria a operar.
  Guards: `RolesGuard`, `CompanyAdminGuard`, `SuperAdminGuard`, `TenantGuard`.
- **Escopo por empresa vem sempre do token**, nunca de parâmetro do cliente.
- Throttle: **a chave é o usuário quando o Bearer token confere**, e o IP
  quando não confere ou não existe (SPEC-017/TASK-006). **Exceto onde o
  limite existe para conter quem ainda não é ninguém** — login, aceite de
  convite, auto-cadastro e leitura pública contam **sempre por IP**, via
  `@ContagemPorIp()`. Ver seção 10.

## 7. Regras de camada (com gate)

| Regra | Gate |
|---|---|
| Controller não contém regra de negócio — valida, resolve identidade e delega | revisão + `*.service.spec.ts` cobre a regra, não o controller |
| Só o módulo dono escreve na sua tabela; os outros chamam método público dele | testes provam a delegação (ex.: MOD-001 não chama `tx.aluno.create`) |
| Invariante crítica é constraint de banco, não `if` de aplicação | ensaio de migration tenta violar cada constraint antes de aplicar |
| Rota autenticada nova nasce coberta por INV-008 | está no `JwtAuthGuard`; sair da trava exige `@PermiteSenhaTemporaria()` explícito |
| `openapi.json` nunca fica stale | CI regenera e falha em `git diff --exit-code` |
| Schema e banco não divergem | `prisma migrate diff` deve devolver "empty migration" |

## 8. Requisitos de plataforma

Node 22+ (CI usa 22; local 24). `pnpm`. Deploy: DigitalOcean App Platform
(Basic), domínio `api.playck.com.br`. Sem fuso configurável: datas e horas
são tratadas como hora local da empresa — **dívida consciente**, ver Gaps.

## 9. Gaps e pontos de atenção

| # | Gap | Severidade |
|---|---|---|
| 1 | ~~Professor não tem identidade~~ — **fechado em 2026-08-22 (SPEC-013)**. O que sobra: professor só lê; não há chamada/presença, e não existe modelo para isso | Baixa — escopo declarado |
| 2 | **Sem fuso horário configurável.** Funciona enquanto todas as empresas estiverem no mesmo fuso; vira defeito silencioso na primeira fora | Média — gatilho declarado |
| 3 | **Formato antigo de `POST /bookings` ainda aceito**, para não quebrar frontend em produção durante o deploy. Condição de saída no DTO | Média — dívida datada |
| 4 | **`courts/` acumula 4 controllers e ~750 linhas de service.** Ainda coeso (tudo toca a linha do tempo), mas é o candidato natural a divisão | Média |
| 5 | Ocupação de turma não tem `aluno_id`: não há como cancelar/remarcar uma ocorrência por aluno (GAP-008). `presencas` é base para resolver, mas **não resolve** — remarcar exige estado além de presente/ausente/justificado | Média — adiado por decisão |
| 6 | Cancelar parte de um bloco de reserva não é suportado (GAP-013) | Baixa |
| 7 | Sem e-mail transacional (GAP-004): recuperação de senha é manual, via admin | Baixa — ADR-013 |
| 8 | `seed.ts` cria dado de demonstração; recusa rodar com `NODE_ENV=production` sem variável explícita | Baixa — mitigado |
| 10 | ~~Nenhum papel de painel tem recuperação de senha~~ — **fechado para `company_admin` em 2026-08-23 (SPEC-016)**: o super admin gera senha temporária pelo SAdmin. **Sobra o `super_admin`**, que não tem papel acima para autorizar — runbook manual em `OPERATIONS.md`, com gatilhos declarados na LIM-010 | Média — limite declarado |
| 11 | **DEF-006 — o `GET` e o `PUT` da chamada discordam sobre quem ela cobre.** `chamada()` com cabeçalho `completa` devolve o snapshot (INV-020 estrita); `salvarChamada()` recalcula `esperados` como `matriculados hoje ∪ já registrados`. Matrícula posterior a uma chamada completa faz o `PUT` do que o próprio `GET` devolveu virar 422 `CHAMADA_INCOMPLETA`, acusando aluno que a tela não mostra — e sem saída pelo produto (LIM-002: o gestor só lê) | **Alta quando ocorrer** — reproduzida em produção em 2026-08-23 |
| 12 | **O histórico do gestor não expõe `completude`** (`historicoDaTurma`). Ele devolve `chamadaFeita` derivado de `presencas.length > 0`, então o gestor não distingue chamada completa de legada `desconhecida` — a informação existe no cabeçalho e não chega a quem lê | Baixa — some quando a TASK-001..004 da SPEC-015 sair |
| 13 | **`ocorrenciasDaTurma` ordena `data desc` sem teto futuro**, então as ocorrências futuras ficam acima da única lançável: o card "fazer chamada" é sempre o último da lista. Medido em produção em 2026-08-23 (9º de 9 na Turma 02; 15º de 16 na turma 01, que ainda tem 8 ocupações canceladas duplicando as ativas) | Baixa — atrito na operação mais frequente do professor |
| 14 | **`PUT /courts/:id/horarios` com o corpo que o `GET` devolveu quebra a herança.** Quadra que herda o padrão devolve `origem: "herdado"` e os 7 dias herdados; salvar isso sem alterar nada cria horário próprio e a quadra para de acompanhar o padrão da empresa. **Não é defeito hoje** — a tela avisa (*"Salvar aqui cria um horário próprio para ela"*) e oferece "Voltar a usar o padrão". **Mas a segurança mora na frase da tela, não no contrato:** qualquer outro cliente que faça a ida e volta quebra a herança em silêncio | Baixa — declarada na UI, não no contrato |

## 10. Catálogo modular observado

| ID | Módulo | Escreve em | Invariantes |
|---|---|---|---|
| MOD-001 | AuthIdentity | `usuarios`, `refresh_tokens`, `convites_aluno` | INV-002, INV-004, INV-008, INV-009, INV-013 |
| MOD-002 | CompanyManagement | `empresas` | INV-005 |
| MOD-003 | PeopleManagement | `alunos`, `professores`, `niveis` | INV-002, INV-006, INV-010, INV-013, INV-014 |
| MOD-004 | ClassScheduling | `turmas`, `turma_alunos`, `presencas`, `chamadas` | INV-003, INV-012, INV-015 a INV-020, INV-026, INV-027 |
| MOD-005 | CourtBooking | `quadras`, `ocupacoes_quadra`, `horarios_funcionamento`, `pedidos_reserva` | **INV-001**, INV-007, INV-011 |
| MOD-006 | PaymentHandoff | `config_pagamento_empresa` | INV-007 |
| MOD-007 | DashboardReporting | — (só leitura) | — |
| MOD-008 | StorageMedia | `arquivos_pendentes_exclusao` | INV-030 a INV-033, INV-035 a INV-039, INV-042 a INV-044, INV-046 a INV-048 |

**Dependências observadas entre módulos:** `AuthModule → PeopleModule`;
`ClassesModule → CourtsModule, PeopleModule`; `CourtsModule → PeopleModule`;
`PaymentConfigModule → CourtsModule`;
`ClassesModule, PeopleModule, DashboardModule → FrequenciaModule`. Sem ciclos.
**`StorageModule` não tem dependente nenhum hoje** — é fundação registrada
antes do consumidor, e quem passa a depender dela é a SPEC-018. Exporta
`StorageService` (o caminho de leitura, com a conferência obrigatória) e
`STORAGE_PROVIDER`; **não exporta a configuração**, que carrega o segredo do
Spaces.

**Duas raízes de lock, e são de naturezas diferentes.** `turmas` é a raiz do
agregado da turma (INV-029), com `FOR UPDATE` de linha. A **chave do objeto**
é a raiz do storage (INV-039), com advisory lock — e a raiz é o objeto, não o
recurso de domínio, porque o recurso disputado é o objeto no bucket.

**Ordem global (INV-042):** locks de domínio primeiro, advisory por chave
depois, nunca ao contrário; múltiplas chaves em ordem lexicográfica; e **o
worker de exclusão nunca toma lock de linha** — é a regra que mais protege,
porque ele é assíncrono e roda sozinho, o candidato natural a segurar uma
linha esperando outra coisa.

**Concorrência: `turmas` é a raiz de lock do agregado da turma (INV-029).**
Quatro caminhos a travam antes de qualquer outra linha —
`allocateStudent`, `removeStudent`, `ClassesService.update` (por
`tx.turma.update`, que já é lock exclusivo) e `PresencaService.salvarChamada`
(passo 0). Ordem de aquisição única, logo sem ciclo de lock.

Duas armadilhas, cada uma descoberta por uma rodada de validação cruzada:
**ler antes de travar** é ter o lock sem a garantia; e **travar e ler no
mesmo statement** também não basta, porque em `READ COMMITTED` o snapshot é
do statement e só a linha travada é reavaliada (EvalPlanQual) — as demais
relações do `JOIN` ficam no snapshot de antes da espera. Detalhe em
`DATA_MODEL.md`, seção "Concorrência".

**Quatro runners de teste, e a diferença entre eles é o que cada um consegue
reprovar:** `pnpm test` (unit, Prisma mockado), `pnpm test:e2e` (Supertest,
também mockado), **`pnpm test:banco`** — suítes que exigem Postgres real,
que o CI sobe como serviço. Mock não tem lock, snapshot nem constraint;
`test/banco/` existe porque metade das provas da SPEC-014/015 depende
exatamente disso, e a SPEC-017 acrescentou `fila-exclusao.db-spec.ts`, que é
o **ensaio de violação** das constraints da fila: cada teste tenta escrever o
estado proibido e exige que o banco recuse.

E **`pnpm run test:bucket`** (FIT-006), que fala com o **bucket real**. Exige
as 6 variáveis `SPACES_*` e só escreve sob um prefixo próprio. É o único
runner que consegue reprovar ACL por arquivo, CDN, assinatura que expira e
"1 objeto". A tabela de provas está em
`specs/changes/017-armazenamento-de-arquivo/FIT-006.md`.

Ele tem **job próprio no CI** (`fit-006`), serializado por `concurrency` — a
chave é derivada do conteúdo, então dois jobs simultâneos gerariam a mesma
chave e um apagaria o objeto que o outro lê. **Sem os secrets configurados o
job avisa em vez de passar em silêncio**: job verde sobre nada é pior que job
nenhum. A *trava* da suíte tem prova separada
(`test/bucket/trava-do-bucket.e2e-spec.ts`), que roda no CI sem credencial.

**Throttle: a chave é o USUÁRIO, não o IP** (SPEC-017/TASK-006). O guard
global é o `ThrottlerPorUsuario`, e **ele confere o Bearer token ele mesmo** —
`APP_GUARD` roda antes do `JwtAuthGuard` de rota, então `request.user` ainda
não existe. A primeira versão lia `request.user` e caía no IP em silêncio;
foi a 3ª validação cruzada que pegou. É `verify`, nunca `decode`: um `sub`
não conferido daria baldes infinitos a quem trocasse o `sub`, o que é pior
que contar por IP. Sem token, o IP é o piso.

**E há rota onde identidade não pode mudar a chave.** `/auth/login` e
companhia contam sempre por IP: este produto tem **auto-cadastro**, então um
balde por conta seria o mesmo que limite nenhum. A marca `@ContagemPorIp()`
vem junto com o `@Throttle` em `LimiteDeLogin()` / `LimitePublico()`
(`common/throttle/contagem-por-ip.ts`) — as duas metades de uma decisão só,
pelo mesmo motivo da INV-048. **Rota pública nova precisa usar as fábricas**;
o gate é `contagem-por-ip.spec.ts`, que confere os handlers reais.

## 11. Patterns observados

**Observado não é aprovado** (`A_Method_PatternMap.md`). Padrões recorrentes
neste código, com onde vê-los:

- **Claim atômica** (`updateMany` com condição no `WHERE` + `count === 1`):
  rotação de refresh token e aceite de convite. Substitui ler-e-decidir, que
  não é seguro sob `READ COMMITTED`;
- **Constraint como garantia, aplicação como mensagem**: pré-checagem existe
  para o erro ser compreensível; quem garante é o banco;
- **Método público em vez de escrita cruzada**: MOD-004 e MOD-006 chamam
  MOD-005; MOD-001 chama MOD-003;
- **Fonte única de resolução**: `HorarioFuncionamentoService` responde
  "está aberto?" para disponibilidade, criação, agenda e dashboard.

`PATTERN_MAP.md` ainda não existe (ver `DOCUMENTATION_INDEX.md`).
