# ARCHITECTURE — `back` (PlayCK)

**Fonte: análise direta do código.** Data: 2026-08-25.
**Commit de referência:** a **SPEC-017 completa** (TASK-001 a 007) mais a
**SPEC-018:TASK-001** (as seis colunas de mídia), 2026-08-24/25, a partir de
`f75615b`. Por nome e não por hash porque este arquivo faz parte do próprio
commit — um documento não consegue citar o hash que ele ajuda a formar.

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

**A primeira mídia do produto entrou em 2026-08-25** (SPEC-018/TASK-003):
`PUT`/`GET`/`DELETE /api/v1/me/foto`, em `auth/me-foto.controller.ts` +
`auth/foto-de-perfil.service.ts`. **MOD-001 é o dono**, porque
`usuarios.foto_key` é tabela dele — e por isso `AuthModule` passou a
importar `StorageModule`.

**Não há id na URL, e é essa a implementação da AC-004.** "Um usuário só
sobe a própria foto" não é conferido por comparação: não existe caminho pelo
qual outro id chegue. Guarda que compara `params.id` com `token.sub` é
guarda que alguém pode esquecer de escrever na rota seguinte.

**A ordem das escritas é a parte frágil, e está coberta por teste:** storage
**antes** do banco (na ordem inversa, uma falha deixaria a coluna apontando
para objeto inexistente — imagem quebrada na tela de quem acabou de subir);
enfileiramento **dentro** da mesma transação do `UPDATE` (fora dela, existe
a janela em que a chave antiga fica órfã para sempre); e o 403 da AC-022
**antes** de validar, hashear ou gravar (depois, viraria 500 vindo de
constraint).

**O `GET /me/foto` não estava na tabela de contrato da spec**, e a adição é
deliberada: sem ele a AC-003 não teria por onde acontecer. É endpoint
próprio, e não um campo em `/auth/me`, **porque a URL expira** — embutida no
login, ficaria velha numa sessão longa.

**A logo da empresa entrou logo depois** (SPEC-018/TASK-006, feita antes da
004 e da 005 por decisão do Israel): `PUT`/`DELETE /api/v1/companies/:id/logo`
em `companies/company-logo.controller.ts` + `logo-da-empresa.service.ts`.

**Aqui o escopo NÃO é estrutural, e é a diferença que importa.** Em
`/me/foto` não havia id na URL; aqui há, porque o `super_admin` também
alcança qualquer empresa. O `RolesGuard` decide *quem entra na rota*, o
serviço decide *qual empresa cada um alcança*, e a recusa é **404, nunca
403** (AC-014).

**`LogoDaEmpresaService.resolver()` é o único lugar que traduz `logo_key` em
URL**, com o fallback para a `logo_url` antiga (AC-013). Ele é chamado por
quatro rotas — `/me/company`, `/public/companies/:slug`, `/companies` e
`/companies/:id` — e existe justamente para não haver quatro cópias do mesmo
`??`, que seriam quatro chances de alguém apagar da tela a logo de quem ainda
usa URL externa. É **fail-soft**: chave corrompida cai para a antiga e vai
para o log, em vez de derrubar uma listagem inteira.

**A chave crua nunca sai na resposta.** `logo_key` é removida antes de
serializar: montar URL a partir dela contornaria a conferência do
`StorageService` (INV-037).

**A imagem de quadra veio em seguida** (SPEC-018/TASK-005):
`PUT`/`DELETE /api/v1/courts/:id/imagem` em
`courts/court-image.controller.ts` + `imagem-da-quadra.service.ts`.

**O que a separa da logo é a confirmação, e ela tem três camadas.** A logo é
material corporativo e sobe sem pergunta; a imagem de quadra é pública,
permanente e pode mostrar aluno — que pode ser menor de idade. A decisão 1 da
spec (opção B, Israel, 2026-08-23) manteve a imagem pública e exigiu
afirmação explícita:

1. **o servidor exige o campo `semPessoasIdentificaveis`** (AC-007). É
   conferido **antes de tudo** — antes de validar o WebP, antes do sha256,
   antes do bucket — porque a AC-007 diz "nada gravado", e nada gravado
   inclui objeto órfão;
2. **o autor e a data são gravados** (AC-008), e vêm do **token**, nunca do
   formulário. Trocar a imagem **regrava** os dois: a confirmação vale para
   aquela imagem, não é licença permanente para a quadra;
3. **o banco não confia em nenhuma das duas.** A constraint
   `quadras_imagem_confirmada_check` exige as três colunas juntas ou
   nenhuma. Código que esquecesse o autor não escreveria linha torta — não
   escreveria. Provado por violação: imagem sem confirmação e confirmação sem
   imagem são recusadas pelo Postgres.

**A armadilha desta rota é o multipart, e ela é de tipo, não de regra.** O
campo chega junto do arquivo, e **multipart não transporta boolean** — `true`
vira a string `"true"`. O jeito ingênuo (`Boolean(valor)`) aceitaria
`"false"`, porque toda string não vazia é verdadeira em JavaScript: uma tela
com a caixa **desmarcada** passaria pelo gate que existe para barrá-la, e a
linha gravada diria que alguém confirmou. Por isso `confirmouSemPessoas()`
tem lista fechada — `true` e `"true"`, mais nada.

**`super_admin` não alcança esta rota**, ao contrário da logo, e é
estrutural: ele não tem empresa, a chave começa por
`empresas/<company_id>/` (LIM-005), e quem confirma responde por um clube.

**`ImagemDaQuadraService.resolver()` é o único lugar que traduz
`imagem_key` em URL**, pela mesma razão do `resolver()` da logo, e é
chamado de dentro de `CourtsService.toQuadraResponse()` — ou seja, **toda**
leitura de quadra passa por ele. Fail-soft: chave corrompida vira `null` na
tela e erro no log.

**A foto de professor fechou a SPEC-018** (TASK-004):
`PUT`/`DELETE /api/v1/teachers/:id/foto` em
`people/teacher-photo.controller.ts` + `foto-de-professor.service.ts`.
`company_admin` só.

**O que ela tem de próprio é a INV-034, e ela é de LEITURA.** A foto exibida
de um professor é `coalesce(usuarios.foto_key, professores.foto_key)` — duas
colunas, dois donos:

| Coluna | De quem | Quem sobe | Tipo de mídia |
|---|---|---|---|
| `usuarios.foto_key` | a pessoa | ela mesma, em `/me/foto` | `perfil` |
| `professores.foto_key` | a ficha | o gestor, aqui | `professor` |

**As duas ficam preenchidas ao mesmo tempo no fluxo normal**, e isso não é
anomalia: o professor entra sem conta (`professores.usuario_id` é nulável),
o gestor põe a foto, e `POST /teachers/:id/acesso` cria o login depois.

**A rota ACEITA professor que já tem conta**, e era decisão em aberto. O
`STATUS.md` a formulava dizendo que aceitar "grava um objeto que ninguém
nunca vai ver" — **falso no caso comum**: só é invisível se a pessoa já tiver
subido a própria foto, e a maioria não subiu. Recusar criaria a assimetria de
o mesmo professor aceitar a foto cinco minutos antes de ganhar o acesso e
recusá-la cinco minutos depois. O que se grava continua sendo a ficha:
`usuarios.foto_key` é da pessoa, e escrever lá seria o gestor trocando a
imagem de alguém.

**`FotoDeProfessorService.resolver()` é o único lugar com a precedência**, e
é chamado de `TeachersService` — toda leitura de professor passa por ele.
Diferente dos outros dois `resolver()`, este **assina** (a foto de professor
é privada) e por isso é `async`; a listagem resolve com `Promise.all`.

**Os catálogos de quadra entraram em 2026-08-26** (SPEC-020/TASK-001):
`esportes_de_quadra` e `categorias_de_quadra`, no molde de `niveis`.
**Só a migration** — nenhuma rota ainda.

**O achado que mudou a task:** já existiam **duas** listas de esporte em
texto livre que nunca se falavam — `empresas.esportes` (`text[]`, escrita
pelo `super_admin`, lida pela lista do SAdmin) e `quadras.esporte` (`text`,
escrita pelo gestor, e é ela que alimenta o filtro do app do aluno). O
catálogo seria a terceira. O backfill semeou a **união** das duas, por
empresa, deduplicando por `lower(nome)` e preferindo a grafia declarada.

**As rotas dos catálogos entraram na TASK-002:** `/court-sports` e
`/court-categories`, com `CatalogoDeQuadraService` como base abstrata e dois
concretos que só dizem três coisas — qual tabela, como se chamam, e o que
conta como "em uso".

**Base compartilhada, e não dois serviços iguais.** A duplicação do
`comprimir-imagem.ts` tem a desculpa do poly-repo (ADR-001, sem pacote
compartilhado, custo declarado); esta seria dentro do mesmo módulo. Se um
terceiro eixo aparecer, são três linhas e nenhuma regra nova.

**A comparação de nome é case-INSENSITIVE aqui, e o banco não é.** O
`UNIQUE(company_id, nome)` distingue "Tênis" de "tênis" — e o defeito que a
SPEC-020 existe para resolver é exatamente esse. Quem impede a segunda grafia
é o serviço; o banco fica como a rede que pega o caminho que não passar por
ele. E há `trim` antes de julgar: `" Tênis"` e `"Tênis"` passariam pela
checagem como nomes diferentes.

**Os controllers herdam os decorators de rota de uma classe base abstrata**, e
isso é aposta no comportamento do Nest — teste de serviço passaria intacto com
as rotas não registradas, e o defeito só apareceria como 404 em produção. Por
isso o primeiro teste de `court-catalogs.e2e-spec.ts` chama-se *"A ROTA
EXISTE"*.

**Uma sabotagem que passou mudou o teste, não o código.** Trocar o `mode:
'insensitive'` do serviço não derrubava nada: o dublê do e2e comparava com
`toLowerCase()` **sempre**, então o comportamento central da task não era
provado por ninguém. O dublê passou a honrar o `mode`.

**A INV-054 é FK composta**, e é o que impede a quadra do clube A apontar
para o esporte do clube B — FK simples não sabe de `company_id`. Provada por
violação em `test/banco/catalogos-de-quadra.db-spec.ts`, junto com a
unicidade por empresa e a recusa de apagar opção em uso.

**A própria migration carrega a prova da AC-010:** um bloco `DO` que
**aborta** se alguma quadra com esporte preenchido ficar sem `esporte_id`.

**A contract (TASK-004) fechou em 2026-08-26**, e a assertiva dela é mais
dura: aborta se **qualquer** quadra ficar sem `esporte_id`, incluindo as de
texto em branco que a expand tolerava. **Ela abortou de verdade** ao rodar
contra o harness, nomeando a quadra — que é a diferença entre "3 quadras sem
esporte" (manda procurar) e o nome (manda consertar).

As duas colunas de texto saíram: `quadras.esporte` e `empresas.esportes`.
E **o `openapi.json` não mudou nem um byte** — a TASK-008 já tinha trocado a
fonte de `esportes` na resposta de empresa mantendo a forma `string[]`, o
que é exatamente o que permitiu derrubar a coluna sem tocar no SAdmin.
Migration que deixa a afirmação para um teste rodar depois já aplicou o dano
quando alguém descobre.

**FIT-007 prova os portões nas ROTAS REAIS** (`test/fit-007.e2e-spec.ts`,
AC-018). O FIT-006 exercita um **controller de fixture** da SPEC-017: prova
que a configuração de upload funciona, **não** que as rotas do produto a
usam.

A INV-048 fez da configuração um decorator — `@UploadDeMidia()` — porque
*"limite que a rota pode esquecer de pedir é limite que uma rota nova não vai
ter"*. O FIT-007 é essa frase virada em teste: monta os **quatro** controllers
de upload no mesmo módulo e roda a **mesma tabela de portões** contra os
quatro — 413, campo `arquivo`, WebP-only, chunk de metadado, e "nada gravado
em recusa".

**Cada rota tem um controle positivo** (um WebP válido que passa) antes dos
quatro portões. Sem ele, um 500 em qualquer caso daria "não é 200" e os
portões pareceriam funcionar.

**Conferido por sabotagem:** remover `@UploadDeMidia()` da rota de quadra
derruba 4 dos 5 testes **daquela rota**, e só dela — as outras três seguem
verdes. É exatamente o cenário "rota nova esqueceu o decorator".

E há um teste da própria tabela: ele lê o `openapi.json` — que é **gerado do
código**, não uma segunda lista à mão — e exige que toda rota `PUT` com
`multipart/form-data` esteja declarada em `ROTAS`.

**E ele é fail-soft por cima de um `urlDeLeitura` que não é.**
`StorageService.urlDeLeitura` lança 404 em chave inválida — certo numa rota
de um objeto só, errado numa listagem, onde uma linha ruim derrubaria a
página inteira. O `try/catch` de `assinarOuNulo` existe por isso, e o log
registra **qual dos dois lados** falhou.

**E há uma exclusão que este projeto NÃO faz** (achado da TASK-008,
2026-08-26): o produto **não apaga recurso nenhum**. Não existe `@Delete`
nem `.delete()` de Prisma para aluno, professor, quadra ou empresa — as
únicas exclusões do sistema são `turma_aluno`, `horario_funcionamento` e
`nivel`, nenhuma com coluna de mídia. Empresa se **inativa**.

Por isso a cascata (AC-011) e o lote (AC-019..021) da SPEC-018 **não têm o
que disparar**, e não foram implementados. Quando a exclusão entrar, a lista
para coletar as chaves já existe: `storage/colunas-de-midia.ts`, a mesma do
checker.

**`INV-041` — inativar preserva a mídia** — tem prova própria e transversal
em `storage/inv-041-inativar-nao-apaga.spec.ts`. Ela estava sendo cumprida
**por ausência** (nenhum serviço de status conhece a fila), que é a forma
mais frágil de cumprir: um teste de "a fila não foi chamada" passaria mesmo
com o código todo apagado. O que o teste afirma é o que um violador teria de
escrever — a coluna de mídia no `data` do `update`.

**O worker deixou de ser fail-closed em 2026-08-26** (TASK-007):
`checker-de-referencia.service.ts` implementa o `KeyReferenceChecker` que a
SPEC-017 declarou como porta, e se registra sozinho no `onModuleInit`.

**Até esse dia o worker não apagava nada.** O `KeyReferenceRegistry`
respondia `true` a qualquer pergunta (INV-044) — "sem checker, tudo é
referenciada" — porque uma fundação no ar antes do consumidor não pode
apagar por não saber quem aponta. Com o registro, ele passa a apagar de fato
(AC-016). **É a mudança mais perigosa da spec inteira:** antes, um bug aqui
deixava lixo; agora, apaga arquivo em uso.

Duas defesas contra isso:

1. **Fail-closed também no erro.** Consulta que estoura responde
   `true` — banco indisponível significa "não sei", nunca "pode apagar". O
   objeto fica um ciclo a mais no bucket, o que custa centavos.
2. **A lista de colunas é uma só** (INV-045), em `colunas-de-midia.ts`, e
   **um teste a confere contra o schema**, não contra outra lista.

**A segunda é o que faz a INV-045 sobreviver.** Invariante de cobertura morre
em silêncio: alguém acrescenta `quadras.imagem_capa_key` daqui a seis meses,
esquece do checker, e o worker apaga arquivo em uso — sem erro, sem alerta,
só a imagem sumindo. `colunas-de-midia.spec.ts` lê o **DMMF do Prisma**
(gerado de `schema.prisma`) e falha no dia em que aparecer coluna de chave
que ninguém ensinou ao checker. Exceção é possível, mas exige **motivo
escrito** no próprio arquivo — hoje há uma:
`arquivos_pendentes_exclusao.key`, que é a chave **na fila para ser
apagada**, não uma referência a ela.

**E há prova contra Postgres real** (`test/banco/checker-de-referencia.db-spec.ts`).
Os testes de banco do worker que já existiam usam checker **falso**
(`() => Promise.resolve(false)`): provam o worker dada uma resposta, nunca o
checker de verdade lendo as colunas de verdade. Entre os dois havia um vão, e
era o vão do erro caro — delegate trocado, coluna esquecida na lista. Tirar
`quadras.imagem_key` da lista central faz o worker **apagar a imagem de uma
quadra em uso**, e três testes caem, dois deles de integração.

**O teste tem controle positivo**, e ele já pegou algo: a primeira versão do
regex de descoberta exigia `Key` maiúsculo e não encontrava o campo `key`
da fila. Sem a asserção "o schema de fato tem colunas de chave", um regex
quebrado faria todas as outras passarem por não encontrarem nada — e o teste
que existe para avisar viraria o que garante silêncio.

**`TeachersService` parou de devolver a linha crua do Prisma.** Enquanto
`professores.foto_key` era sempre nula isso não custava nada; com a TASK-004
escrevendo nela, a **chave crua sairia na resposta** (INV-037). Entrou
`comFoto()`, e um `carregarCru()` separado para `update`/`gerarAcesso`,
que precisam de campos que a resposta não leva.

**`/me/company` passou a aceitar `aluno` e `professor`** — o app precisa ler
a marca do clube. O que a rota devolve já era alcançável por eles: `slug` é o
link público de cadastro, `nome` e `logoUrl` aparecem na vitrine pública.

**As seis colunas de mídia existem desde 2026-08-25** (SPEC-018/TASK-001),
migration expand pura, sem backfill. **Quatro já têm escritor**, e o que falta
é uma só:

| Coluna | Escritor | Task |
|---|---|---|
| `usuarios.foto_key` | `PUT /me/foto` | 003, no ar |
| `empresas.logo_key` | `PUT /companies/:id/logo` | 006, no ar |
| `quadras.imagem_key` + `imagem_confirmada_por`/`_em` | `PUT /courts/:id/imagem` | 005 |
| `professores.foto_key` | `PUT /teachers/:id/foto` | 004 |

**As seis têm escritor desde 2026-08-26.** A tabela fica porque é o lugar
onde a planta mais envelhece, e porque diz **qual rota** escreve em cada
coluna — que é a pergunta real de quem chega. Ao ler, confira contra o
`openapi.json`.

**O que NÃO existe, e a lista importa mais que o que existe:** upload de
**professor e quadra** (TASK-004 e 005) e **nenhum `KeyReferenceChecker`
registrado** — sem ele o worker é fail-closed e
não apaga nada. A tabela da fila está criada e **vazia**, porque quem
enfileira é quem apaga referência, e isso é da SPEC-018:TASK-008. **A
SPEC-017 está completa**; da SPEC-018 saíram as TASK-001, 002, 003 e 006.

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

**17 tabelas e 10 enums** no `schema.prisma` (conferido em 2026-08-25, depois da
SPEC-018:TASK-001 — que **não** criou tabela nem enum: só seis colunas de
mídia, todas nulas).

| Tabela | Dono | Papel / quirk |
|---|---|---|
| `empresas` | MOD-002 | tenant. `slug` único alimenta o link público de cadastro; `permite_auto_cadastro` liga/desliga esse link. `logo_key` (SPEC-018) é o upload real e **convive** com `logo_url`, que não migra (AC-012) |
| `usuarios` | MOD-001 | identidade. E-mail único **global** (INV-004). `senha_temporaria` tranca a conta até a troca (INV-008). `foto_key` (SPEC-018) é a foto de quem **tem conta**; CHECK exige empresa, então `super_admin` não tem foto |
| `refresh_tokens` | MOD-001 | rotação por claim atômica; reuso revoga a sessão inteira |
| `convites_aluno` | MOD-001 | `token_hash` é **sha256 determinístico**, não bcrypt — o token é a chave de busca da claim atômica (INV-009) |
| `pedidos_reserva` | MOD-005 | idempotência **do pedido**, com fingerprint do payload |
| `alunos` | MOD-003 | `status` (ativo/inativo) ≠ `vinculo` (pendente/aprovado/recusado). O segundo é INV-010 |
| `professores` | MOD-003 | `usuario_id` **anulável e único** (INV-014). Nulo é o estado normal: ficha sem acesso. `ON DELETE SET NULL` — apagar a conta não apaga o histórico de turmas. `foto_key` (SPEC-018) existe **por causa** disso: professor sem conta não teria onde guardar foto. Leitura é `coalesce(usuarios.foto_key, professores.foto_key)` — INV-034 |
| `niveis` | MOD-003 | único por `(company_id, nome)` |
| `quadras` | MOD-005 | `preco_hora` é o preço **atual**; o cobrado fica em `ocupacoes_quadra.valor`. `imagem_key` é **pública** e vem com `imagem_confirmada_por`/`_em`: as três vivem e morrem juntas por CHECK (SPEC-018, decisão 1) |
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
| `quadras_imagem_confirmada_check` (SPEC-018) | AC-007/008 no banco: `imagem_key`, `imagem_confirmada_por` e `imagem_confirmada_em` são as três nulas ou as três preenchidas. Sem isto, imagem pública sem autor seria gravável por qualquer caminho que esquecesse o campo — e a exigência de confirmação viraria aviso de tela |
| `quadras_imagem_confirmada_por_fkey` (`ON DELETE RESTRICT`) | a confirmação vale por ter nome de gente: apagar a conta não pode apagar o autor da afirmação. Mesmo regime de `chamadas.registrada_por` |
| `usuarios_foto_da_empresa_check`, `professores_foto_da_empresa_check`, `quadras_imagem_da_empresa_check`, `empresas_logo_da_empresa_check` (SPEC-018) | INV-030 por coluna de mídia: a chave gravada mora sob a empresa **da própria linha**. Pega chave adulterada no banco, que o prefixo e o escopo por token não pegam — os dois leem o mesmo token. O resto da gramática fica com `chave-de-midia.ts`, fonte única |
| `usuarios_foto_da_empresa_check`, parte `company_id IS NOT NULL` | consequência declarada: **`super_admin` não tem foto de perfil.** A gramática da chave começa por `empresas/<company_id>/` e não representa foto de quem não tem empresa. **Decidido em 2026-08-25** (SPEC-018/LIM-005): é conta operacional e o SAdmin não tem tela de perfil. A rota devolve 403 `PERFIL_SEM_EMPRESA` antes de tocar o storage, para o caso nunca virar 500 vindo de constraint |

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

**55 caminhos, 78 operações HTTP** (conferido em 2026-08-25 contra o
`openapi.json`, depois da SPEC-018/TASK-006). As duas medidas aparecem porque "rotas" é ambíguo: a
versão anterior desta planta dizia "41 rotas" contando caminhos, e trocar
a métrica em silêncio faria o número parecer um salto de escopo.

A fonte é o `openapi.json` **gerado do código**, com gate de CI
(`git diff --exit-code openapi.json`) que falha se ele ficar stale —
verificado funcionando: o arquivo commitado estava em dia. `API_CONTRACTS.md` (raiz) descreve as regras
de negócio por contrato; este documento não as duplica.

### A recorrência da turma é uma tabela filha (SPEC-019)

`turma_encontros` guarda 1..N encontros semanais por turma. As três colunas
que viviam em `turmas` saíram na contract.

**A validação vive fora do serviço** (`encontros.ts`), porque criar e editar
precisam da mesma regra e duas cópias divergiriam. Ela garante a **forma** da
recorrência — pelo menos um, fim depois do início, nenhum par sobreposto — e
**não** garante que caiba na agenda: quem faz isso é o `EXCLUDE`
`no_overlap_por_quadra`, que continua sendo a autoridade final, inclusive
sobre encontros da mesma turma (ele não sabe de qual turma vem cada ocupação).

**A INV-051 ("turma tem ≥1 encontro") NÃO é garantida pelo banco.** Postgres
não expressa "pai com pelo menos um filho" sem trigger, e este projeto tem
zero. Fica com a API e a transação, **declarado em vez de prometido** — a 1ª
rodada de dúvida da SPEC-019 derrubou a versão que prometia o contrário.

**As duas migrations têm preflight que ABORTA**, e o da contract faz três
perguntas: turma sem encontro, encontro com hora inválida, e horário antigo
sem encontro correspondente (backfill parcial). A terceira foi exigida pela
validação cruzada. **A primeira disparou de verdade** contra o harness,
nomeando as turmas — que é a diferença entre "2 turmas sem encontro" e algo
consertável.

### O caminho de erro deixou de ser afirmação (SPEC-023, 2026-08-28)

**Até 2026-08-28 a conta era `{2xx: 90, 4xx: 0}`** — medida em 2026-08-27 e
registrada como LIM-004. Todas as respostas declaradas eram de sucesso, e
**nenhum corpo de erro tinha schema**, embora sejam eles que decidem desvio
de sessão (`SENHA_TEMPORARIA` manda ao primeiro acesso, `CONTA_INATIVA`
encerra a sessão).

A SPEC-023 tirou a conta do zero: **`{2xx: 93, 4xx: 5}`**. Os cinco são os
erros de matrícula do aluno (`ALUNO_NAO_APROVADO`, `TURMA_INATIVA`,
`LIMITE_DE_TURMAS`, `TURMA_CHEIA`, `AULA_HOJE`), publicados via
`ErroDeMatriculaResponseDto`.

**A regra que sai daqui:** rota nova cujo erro **muda o que a tela mostra**
publica o schema do erro no mesmo commit. Foram três ciclos escrevendo que
contrato errado é pior que contrato ausente antes de alguém publicar o
primeiro `4xx` — aviso não é mecanismo.

### O aluno entra e sai de turma (SPEC-023)

`MatriculaDoAlunoService` mora fora de `ClassesService` de propósito: lá é o
CRUD do gestor, e as regras do aluno são de outro ator. Misturar deixaria as
regras novas valendo, sem querer, para o caminho do gestor — o oposto do que
a spec decide (REQ-006: o gestor não perde nada).

**O que ele não reinventa é a trava.** `INV-003` é `SELECT ... FOR UPDATE` na
linha da turma e existe desde a SPEC-003; o caminho do aluno usa a mesma
trava na mesma linha. Dois caminhos de matrícula com travas diferentes seriam
duas verdades sobre a mesma vaga.

**E o fuso deixou de ser implícito.** `hojeNoFusoDoClube()`
(`courts/date-time.util.ts`) fixa `America/Sao_Paulo` porque a regra "não sai
no dia da aula" depende de qual dia é — e o projeto não tinha fuso em lugar
nenhum: `myUpcomingClasses` usa `Date.UTC(...)` **até hoje**. O Brasil é
UTC-3, então das 21h à meia-noite locais o UTC já está no dia seguinte, e
aula à noite é o horário mais comum de clube de tênis. Ver
`fuso-do-clube.spec.ts`, que prova o acerto **e** documenta o erro que ele
evita.

### Resposta tipada: 16 de 90, e por que a conta começou em zero

**Até 2026-08-26 nenhuma resposta desta API declarava schema.** Contado, não
estimado: 0 com schema, 90 sem. O Nest só emite schema a partir do DTO de
**corpo de requisição**; resposta exige `@ApiResponse`/`@ApiOkResponse`
explícito, e o projeto não usava nenhum — `grep` por `@Api*Response` no
`src/` inteiro devolvia zero.

**A consequência custou um apagão em produção (DEF-012).** Os três frontends
escreviam à mão *toda* resposta, porque não havia o que gerar. Quando a
SPEC-020/TASK-003 trocou `quadra.esporte` de string para objeto, o tipo
escrito à mão do Cliente continuou dizendo `string`, o typecheck ficou verde
e três telas foram a branco.

Note a assimetria que isso explica: **no mesmo dia**, o Admin pegou um erro de
`UpdateCourtDto` — porque é **requisição**, e requisição tinha schema.

A SPEC-020/TASK-007 tipou a superfície de quadra (**10**: `/courts` × 4,
`/court-sports` e `/court-categories` × 3 cada). A SPEC-019/REQ-006
acrescentou a de turma (**6**), porque foi ela quem quebrou aquelas respostas.

São **16 das 90**. As outras 74 seguem sem schema, e a planta prefere dizer
isso a dar a impressão de que o problema está resolvido.

**A regra que saiu daí, e vale além das duas specs:** quem quebra a forma de
uma resposta paga a proteção **daquela** resposta — nem menos, nem mais.
Publicar as 74 restantes é a SPEC-021/TASK-005; virar mutirão dentro de uma
spec de produto é o erro que originou a SPEC-021 retroativa.

### O que faz um DTO de resposta valer alguma coisa

**Um DTO de resposta escrito à mão é a mesma mentira do tipo escrito à mão no
frontend**, a menos que algo o amarre ao código que produz a resposta. Há duas
amarras, e as duas foram provadas por sabotagem:

| Amarra | Onde | Prova |
|---|---|---|
| `toQuadraResponse(): QuadraResponseDto` | `courts.service.ts` | reintroduzir o DEF-012 no serviço quebra o `tsc`: *Type 'string' is not assignable to type 'OpcaoDeCatalogoResponseDto'* |
| `ConfereContraOContrato<EsporteDeQuadra>` | `catalogos-de-quadra.ts` | acrescentar um campo ao contrato que o Prisma não tem quebra o `tsc` nomeando o campo |

A segunda existe por um motivo específico: o delegate do catálogo usa
`as unknown as DelegateDeCatalogo`, e **duplo cast apaga a checagem**. Sem
essa asserção, renomear `ordem` numa migration continuaria compilando, e o
contrato publicado passaria a mentir. As duas linhas não geram código — são
uma pergunta feita ao compilador.

### `type:` explícito em todo `@ApiProperty`

Não é estilo. Neste mesmo ciclo, um `@ApiPropertyOptional({ format: 'uuid',
nullable: true })` **sem `type`** emitiu schema sem tipo, e o
`openapi-typescript` traduziu para `Record<string, never>` — objeto vazio no
lugar de um uuid. Foi achado pelo typecheck do **Admin**, não por nada aqui.

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
| **Nada dentro de `$transaction` custa uma ida ao banco por item de uma lista.** O laço que consulta por ocorrência cabe no timeout enquanto a lista é pequena, e estoura quando o produto deixa a lista crescer — foi o DEF-013 | `def-013-orcamento-da-transacao.spec.ts` monta `ClassesService`, `CourtsService` e `HorarioFuncionamentoService` de verdade e conta as idas: o teto não pode crescer com o número de encontros |
| **Erro do Prisma só vira 409 se for de dado.** Transação expirada e conexão caída não são corrida perdida — traduzi-las em "conflito de horário" faz o produto mentir sobre uma quadra vazia | `ehCorridaPerdida()` em `courts.service.ts`, com teste de P2028 nos dois caminhos de escrita |
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
estado proibido e exige que o banco recuse. A SPEC-018:TASK-001 acrescentou
`colunas-de-midia.db-spec.ts`, o mesmo ensaio para as seis colunas de mídia —
**12 dos seus 14 testes ficam vermelhos** quando as constraints são
derrubadas, e os 2 que sobrevivem são justamente os dois casos felizes.

E **`pnpm run test:bucket`** (FIT-006), que fala com o **bucket real**. Exige
as 6 variáveis `SPACES_*` e só escreve sob um prefixo próprio. É o único
runner que consegue reprovar ACL por arquivo, CDN, assinatura que expira e
"1 objeto".

**O que a AC-009 afere do CDN mudou em 2026-08-25, e o motivo importa:** o
CDN da DigitalOcean **não repassa o `Cache-Control` do objeto** — devolve o
seu próprio, derivado do TTL do endpoint (`doctl compute cdn list` mostra
`TTL 3600`, e volta `max-age=3600`, sem o token `public`). O objeto está
certo: o teste vizinho lê o mesmo header **pelo S3** e vê
`public, max-age=3600` intacto. A prova passou a exigir a **duração** — a
mesma constante do objeto — e a ausência de `private`/`no-store`. Exigir
`public` seria cobrar do CDN algo que ele não expõe knob para fazer, e FIT
que cobra o impossível vira FIT desligado. A tabela de provas está em
`specs/changes/017-armazenamento-de-arquivo/FIT-006.md`.

Ele tem **job próprio no CI** (`fit-006`), serializado por `concurrency` — a
chave é derivada do conteúdo, então dois jobs simultâneos gerariam a mesma
chave e um apagaria o objeto que o outro lê. **Sem os secrets configurados o
job avisa em vez de passar em silêncio**: job verde sobre nada é pior que job
nenhum. **Os 6 secrets foram cadastrados em 2026-08-25**, então o aviso
acabou: o job agora barra. A *trava* da suíte tem prova separada
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
  "está aberto?" para disponibilidade, criação, agenda e dashboard. Quem
  pergunta muitas vezes usa `carregarLinhas()` + `resolverDeLinhas()` —
  carrega uma vez, resolve em memória. A herança fica num lugar só e o custo
  não vira função do dado (DEF-013).

`PATTERN_MAP.md` ainda não existe (ver `DOCUMENTATION_INDEX.md`).
