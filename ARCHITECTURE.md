# ARCHITECTURE — `back` (PlayCK)

**Fonte: análise direta do código.** Data: 2026-08-22.
**Commit de referência:** `3fd85e5`.

Esta é a planta **AS-IS**: descreve o que existe. Intenção arquitetural vive
em `TARGET_ARCHITECTURE.md` (raiz do workspace) + ADRs em `DECISIONS.md`.
Divergência entre este documento e o código é defeito **deste documento**.

---

## 1. Stack real

Do `package.json` (produção):

| Lib | Versão | Papel |
|---|---|---|
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
Turborepo ou qualquer monorepo (ADR-001 é poly-repo), Redis, fila/worker,
GraphQL, ORM além do Prisma, provedor de e-mail, gateway de pagamento,
storage de arquivos, WebSocket.

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

**15 tabelas e 9 enums** no `schema.prisma` (conferido em 2026-08-23).

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
| `config_pagamento_empresa` | MOD-006 | link/WhatsApp por empresa; `company_id` único |

**Constraints que o Prisma não expressa** (escritas à mão nas migrations, e
que são a garantia real):

| Constraint | Garante |
|---|---|
| `EXCLUDE USING gist ... WHERE status_pagamento <> 'cancelado'` | INV-001: sem overbooking; e cancelar **libera** o slot |
| `UNIQUE NULLS NOT DISTINCT (company_id, quadra_id, dia_semana)` | um único horário padrão por dia (PG 15+) |
| `horarios_coerencia_fechado`, `horarios_hora_cheia` | dia fechado sem horas; horário só em `HH:00` |
| `ocupacoes_valor_por_origem` | `valor` obrigatório em AVULSO, **nulo** em TURMA |
| `ux_ocupacoes_quadra_client_request_id` (parcial) | idempotência anterior à SPEC-011, ainda válida para linhas antigas |

## 4. Estrutura de pastas

```
src/
  auth/            MOD-001 — login, sessão, convites, troca de senha
  companies/       MOD-002 — tenants (+ rota pública por slug)
  people/          MOD-003 — alunos, professores, níveis
  classes/         MOD-004 — turmas
  courts/          MOD-005 — quadras, ocupações, horários, agenda
  payment-config/  MOD-006 — meio de pagamento e status
  dashboard/       MOD-007 — agregações de leitura
  common/          guards, decorators, utils, tipos, smoke
  prisma/          PrismaService (@Global)
```

**Padrão interno de módulo:** `*.module.ts`, `*.controller.ts`,
`*.service.ts`, `*.service.spec.ts`, `dto/`. Serviço que virou fonte de
verdade transversal ganha arquivo próprio (`horario-funcionamento.service.ts`,
`agenda.service.ts`, `slots.util.ts`).

**`courts/` concentra 4 controllers** (courts, bookings, company-settings,
agenda) porque MOD-005 é dono da linha do tempo da quadra e tudo ali a toca.
É o maior módulo do projeto — ver Gaps.

## 5. Contratos de API

**48 caminhos, 67 operações HTTP** (conferido em 2026-08-23 contra o
`openapi.json`, depois da DEF-003, que somou `GET /me/company`). As duas medidas aparecem porque "rotas" é ambíguo: a
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
- Throttle de 10 req/15 min por IP em toda superfície pública.

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
| 9 | **`permiteAutoCadastro` não tem escrita.** É lida em `public-companies.controller.ts` e `auth.service.ts`, e **nenhuma rota a altera** — o REQ-006 da SPEC-009 ("a empresa decide se aceita auto-cadastro") é letra morta: a decisão está congelada no default `true`. Achado em 2026-08-23, na DEF-003. Não é falha de segurança (a trava da ADR-013 é a fila de aprovação, que existe), mas a empresa que for spamada não tem como fechar a porta | Média — requisito não cumprido |
| 10 | **Nenhum papel de painel tem recuperação de senha.** Aluno e professor têm substituto manual (o admin regenera); `company_admin` e `super_admin` não têm nada — perder a senha hoje só se resolve com `UPDATE` direto no banco. Agravado desde a rotação de 2026-08-22, que tirou a senha conhecida do código | Alta — sem contorno |

## 10. Catálogo modular observado

| ID | Módulo | Escreve em | Invariantes |
|---|---|---|---|
| MOD-001 | AuthIdentity | `usuarios`, `refresh_tokens`, `convites_aluno` | INV-002, INV-004, INV-008, INV-009, INV-013 |
| MOD-002 | CompanyManagement | `empresas` | INV-005 |
| MOD-003 | PeopleManagement | `alunos`, `professores`, `niveis` | INV-002, INV-006, INV-010, INV-013, INV-014 |
| MOD-004 | ClassScheduling | `turmas`, `turma_alunos`, `presencas` | INV-003, INV-012, INV-015 a INV-020 |
| MOD-005 | CourtBooking | `quadras`, `ocupacoes_quadra`, `horarios_funcionamento`, `pedidos_reserva` | **INV-001**, INV-007, INV-011 |
| MOD-006 | PaymentHandoff | `config_pagamento_empresa` | INV-007 |
| MOD-007 | DashboardReporting | — (só leitura) | — |

**Dependências observadas entre módulos:** `AuthModule → PeopleModule`;
`ClassesModule → CourtsModule, PeopleModule`; `CourtsModule → PeopleModule`;
`PaymentConfigModule → CourtsModule`. Sem ciclos.

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
