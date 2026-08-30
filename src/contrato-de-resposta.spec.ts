import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SPEC-021/TASK-005 — **o gate que faz a dívida encolher, e nunca crescer.**
 *
 * ## Por que um gate, e não só terminar o trabalho
 *
 * Chegar a 90 de 90 não resolve nada sozinho: a rota número 91 nasce sem
 * schema, e o placar volta a cair sem ninguém reparar. **Foi assim que esta
 * dívida se formou** — o Nest só emite schema para corpo de requisição, então
 * "não declarar resposta" é o caminho de menor esforço e o padrão silencioso.
 *
 * O DEF-012 custou três telas em branco no app do aluno em produção. O que o
 * causou não foi um descuido pontual: foi **90 de 90 respostas sem contrato**,
 * durante meses, sem nada acender.
 *
 * ## As duas asserções, e a segunda é a que importa
 *
 * 1. **Rota fora da lista precisa ter schema.** Barra dívida nova.
 * 2. **Rota na lista não pode ter schema.** Barra a lista de apodrecer.
 *
 * A segunda parece burocracia e é o coração disto. Uma lista de exceções que
 * só cresce vira decoração em três meses — todo mundo já viu isso acontecer.
 * Esta obriga quem consertar uma rota a **apagar a linha dela daqui**, e o
 * arquivo passa a medir o progresso em vez de descrevê-lo.
 *
 * ## Por que ler o `openapi.json` e não os decorators
 *
 * O `openapi.json` é o artefato que os três frontends consomem
 * (`gen:api-types`), e o CI já o regenera e falha em `git diff --exit-code`.
 * Conferir os decorators provaria que escrevemos decorators; conferir o
 * `openapi.json` prova **o que o cliente recebe** — que é a única coisa que o
 * DEF-012 teria detectado.
 *
 * ## E não, ele não fica cego com um arquivo desatualizado
 *
 * No `ci.yml`, `pnpm test` roda **antes** de `openapi:export` — então este
 * teste lê o arquivo **commitado**, não um recém-gerado. A pergunta óbvia é
 * se dá para escapar dele esquecendo de regenerar. Não dá, e o par é o que
 * fecha:
 *
 * | Cenário | Quem fica vermelho |
 * |---|---|
 * | rota nova sem schema, `openapi.json` regenerado | **este teste** |
 * | rota nova sem schema, `openapi.json` esquecido | o `git diff --exit-code` do passo `openapi:export` |
 *
 * Nenhum dos dois sozinho cobre os dois casos. Juntos, cobrem.
 *
 * ## `204` não entra na conta
 *
 * Resposta sem corpo não tem schema a declarar, e exigir um seria pedir para
 * alguém inventar um objeto vazio só para calar o teste. `@ApiNoContentResponse()`
 * é a declaração certa ali, e o `204` no `openapi.json` é a prova dela.
 */

/**
 * As operações que **ainda não** declaram schema de resposta, em 2026-08-27.
 *
 * **Esta lista só encolhe.** Cada linha aqui é uma resposta que um frontend
 * hoje descreve à mão — e tipo escrito à mão é o que estava por trás do
 * DEF-012, do DEF-014 e do DEF-015.
 *
 * Ao dar schema a uma delas, **apague a linha**. O teste abaixo falha se você
 * esquecer, e a mensagem diz exatamente qual apagar.
 */
const SEM_SCHEMA_DE_RESPOSTA = new Set<string>([
  // **Vazia desde 2026-08-27, e chegar a zero foi o trabalho da TASK-005.**
  //
  // Nasceu com 17 linhas, no mesmo dia, e encolheu até aqui. Deixar a
  // constante em vez de apagá-la é deliberado: é onde a próxima exceção
  // teria de ser escrita, com nome e data, em vez de acontecer em silêncio.
  //
  // Se você veio parar aqui porque um teste abaixo ficou vermelho, a
  // pergunta certa não é "como calo isto" — é por que a rota nova não
  // declara `@ApiOkResponse`. O DEF-012 custou três telas em branco em
  // produção, e a causa foi exatamente esta lista, implícita e com 90 linhas.
]);

const VERBOS = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface Resposta {
  content?: Record<string, unknown>;
}
interface Operacao {
  responses?: Record<string, Resposta>;
}
interface OpenApi {
  paths: Record<string, Record<string, Operacao>>;
}

interface OpenApiCompleto {
  components?: {
    schemas?: Record<
      string,
      { properties?: Record<string, { enum?: string[] }> }
    >;
  };
}

function lerOpenApiCompleto(): OpenApiCompleto {
  const caminho = join(__dirname, '..', 'openapi.json');
  return JSON.parse(readFileSync(caminho, 'utf8')) as OpenApiCompleto;
}

function lerOpenApi(): OpenApi {
  const caminho = join(__dirname, '..', 'openapi.json');
  return JSON.parse(readFileSync(caminho, 'utf8')) as OpenApi;
}

interface Classificada {
  chave: string;
  temSchema: boolean;
  semCorpo: boolean;
}

function classificarOperacoes(): Classificada[] {
  const doc = lerOpenApi();
  const saida: Classificada[] = [];
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const verbo of VERBOS) {
      const op = ops[verbo];
      if (!op) continue;
      const respostas = op.responses ?? {};
      const temSchema = Object.entries(respostas).some(
        ([codigo, resposta]) =>
          codigo.startsWith('2') &&
          resposta.content !== undefined &&
          Object.keys(resposta.content).length > 0,
      );
      saida.push({
        chave: `${verbo.toUpperCase()} ${path}`,
        temSchema,
        semCorpo: Object.keys(respostas).includes('204'),
      });
    }
  }
  return saida;
}

describe('INV-058/INV-060 — contrato de resposta publicado (SPEC-021)', () => {
  const operacoes = classificarOperacoes();

  it('o openapi.json tem operações — se não tiver, o resto deste arquivo é vácuo', () => {
    // Sem isto, um `openapi.json` truncado faria os dois testes abaixo
    // passarem por vacuidade e o gate viraria decoração silenciosa.
    expect(operacoes.length).toBeGreaterThan(80);
  });

  it('nenhuma rota NOVA nasce sem schema de resposta', () => {
    const devedoras = operacoes
      .filter((o) => !o.temSchema && !o.semCorpo)
      .map((o) => o.chave)
      .filter((chave) => !SEM_SCHEMA_DE_RESPOSTA.has(chave));

    expect(devedoras).toEqual([]);
  });

  /**
   * O teste que impede a lista de apodrecer.
   *
   * Se ele falhar, **a mensagem já diz o que fazer**: apagar as linhas
   * nomeadas de `SEM_SCHEMA_DE_RESPOSTA`. É o único jeito de a lista medir o
   * progresso em vez de só registrar a intenção de um dia fazê-lo.
   */
  it('a lista de exceções não guarda rota que JÁ ganhou schema', () => {
    const resolvidas = operacoes
      .filter(
        (o) =>
          (o.temSchema || o.semCorpo) && SEM_SCHEMA_DE_RESPOSTA.has(o.chave),
      )
      .map((o) => o.chave);

    expect(resolvidas).toEqual([]);
  });

  /**
   * E o que a lista aponta precisa existir. Rota renomeada ou removida deixa
   * uma linha órfã aqui, e linha órfã é dívida fantasma: aumenta o número sem
   * corresponder a nada.
   */
  it('a lista de exceções não guarda rota que não existe mais', () => {
    const existentes = new Set(operacoes.map((o) => o.chave));
    const fantasmas = [...SEM_SCHEMA_DE_RESPOSTA].filter(
      (chave) => !existentes.has(chave),
    );

    expect(fantasmas).toEqual([]);
  });
});

/**
 * **DEF-016 — os valores de um `enum` publicado não eram conferidos por nada.**
 *
 * Em 2026-08-27 o `statusPagamento` foi publicado como `'pendente'`. O valor
 * não existe: o enum do banco é `pendente_pagamento`. O `openapi.json` chegou
 * a **se contradizer no mesmo documento** — o filtro de `GET /bookings`
 * publicava um valor e a resposta publicava outro.
 *
 * Nada pegou, e por três motivos que se somaram:
 *
 * | Guarda | Por que não pegou |
 * |---|---|
 * | a amarra de retorno (INV-058) | o campo era `string` no DTO e `string` na origem — nada a comparar |
 * | o gate acima | pergunta "tem schema?", não "o schema está **certo**?" |
 * | os testes | nenhum afirma um valor de `statusPagamento` vindo do banco |
 *
 * O conserto de raiz foi tipar o campo com o enum do Prisma na origem e com a
 * união no DTO — aí o `tsc` compara. Este teste é a rede embaixo disso: ele
 * pega o caso em que alguém declara um `enum:` novo **sem** amarrá-lo, que é
 * exatamente o que aconteceu.
 *
 * ## A regra
 *
 * Todo `enum` publicado numa resposta é **ou** cópia exata de um enum do
 * Prisma, **ou** está declarado abaixo como enum de código. Não há terceira
 * opção — e é a ausência dela que impede uma transcrição errada de passar.
 */
/**
 * ## A chave, e por que ela mudou de forma (SPEC-023/SPEC-024)
 *
 * Esta tabela era indexada **só pelo nome do campo**, e isso funcionou
 * enquanto cada nome aparecia uma vez. A SPEC-023 quebrou a premissa: ela
 * publicou um `motivo` (por que o aluno não pode entrar na turma) que nada
 * tem a ver com o `motivo` da SPEC-015 (por que o aluno entrou na lista de
 * evasão). Dois campos com o mesmo nome e conjuntos diferentes — e a tabela
 * não tinha como dizer isso.
 *
 * A SPEC-024 ia repetir o problema com `code`: `ErroDeMatriculaResponseDto`
 * e `ErroDeAceiteResponseDto` publicam códigos diferentes no mesmo nome.
 *
 * **Agora aceita as duas formas**, e a mais específica ganha:
 * `"Schema.campo"` quando o nome se repete, `"campo"` quando é único. As
 * entradas antigas ficam como estavam — a mudança acrescenta precisão sem
 * pedir reescrita de quem já estava certo.
 */
const ENUMS_DE_CODIGO = new Map<string, string[]>([
  // SPEC-015 — confiança do cálculo de frequência. Vem de `agrega()`.
  ['confianca', ['alta', 'baixa']],
  // SPEC-010 — estado do expediente resolvido, não coluna.
  ['estado', ['aberto', 'fechado']],
  // SPEC-015 — por que o aluno entrou na lista de evasão.
  ['motivo', ['faltas_seguidas', 'frequencia_baixa']],
  // SPEC-010 — a quadra tem linha própria, ou herda o padrão da empresa.
  ['origem', ['proprio', 'herdado']],
  // SPEC-011 — os três estados de um slot na grade de disponibilidade.
  ['status', ['livre', 'ocupado_turma', 'ocupado_avulso']],
  // O papel do admin inicial, na criação da empresa: sempre este.
  ['role', ['company_admin']],

  // SPEC-027/SPEC-030 — os momentos de uma aula, do ponto de vista da
  // chamada. **As duas listas agora vêm da MESMA função**,
  // `resolverEstadoDaChamada` (`estado-da-chamada.ts`).
  //
  // **O que estava escrito aqui antes ficou falso, e vale registrar por
  // quê.** Dizia: *"`legada` só existe no calendário porque só ele lê
  // `completude` — a lista da turma decide por `_count.presencas`"*. Era
  // verdade, e era exatamente o defeito: duas regras publicando o mesmo
  // vocabulário. A SPEC-030 unificou, e `legada` passou a poder sair dos
  // dois.
  //
  // **Continuam NÃO idênticas, e a diferença é a mesma de sempre:** o
  // calendário esconde ocorrência cancelada (ela não entra no filtro), então
  // lá não há `cancelada`; a lista da turma mostra a cancelada marcada,
  // então lá há. Igualar as duas seria publicar um estado que uma delas
  // nunca devolve.
  [
    'AulaDoDiaDoProfessorResponseDto.chamada',
    ['futura', 'em_andamento', 'pendente', 'feita', 'legada', 'nao_houve'],
  ],
  [
    'OcorrenciaDaTurmaResponseDto.estado',
    [
      'futura',
      'em_andamento',
      'pendente',
      'feita',
      'legada',
      'nao_houve',
      'cancelada',
    ],
  ],

  // SPEC-023 — por que o aluno não pode entrar nesta turma. Chave
  // qualificada porque `motivo` já existe acima com outro significado.
  // A ordem aqui é a ordem das checagens no serviço, e ela É a mensagem:
  // quem não foi aprovado ouve isso antes de qualquer coisa sobre vaga.
  [
    'TurmaDisponivelResponseDto.motivo',
    ['ALUNO_NAO_APROVADO', 'TURMA_INATIVA', 'LIMITE_DE_TURMAS', 'TURMA_CHEIA'],
  ],
  // SPEC-023 — os mesmos quatro, mais o da saída. Vêm de
  // `MatriculaDoAlunoService`; são os primeiros corpos de erro com schema
  // publicado no projeto (LIM-004 saiu de `{2xx: 90, 4xx: 0}`).
  [
    'ErroDeMatriculaResponseDto.code',
    [
      'ALUNO_NAO_APROVADO',
      'TURMA_INATIVA',
      'LIMITE_DE_TURMAS',
      'TURMA_CHEIA',
      'AULA_HOJE',
    ],
  ],
  // SPEC-024 — o portão do aceite. `ACEITE_PENDENTE` vem do `JwtAuthGuard`;
  // `VERSAO_DESATUALIZADA`, do `AceitesService`.
  ['ErroDeAceiteResponseDto.code', ['ACEITE_PENDENTE', 'VERSAO_DESATUALIZADA']],
  // SPEC-025 — as duas recusas de avaliar uma aula. Vêm de
  // `AvaliacaoDeAulaService.exigirDireitoDeAvaliar`.
  [
    'ErroDeAvaliacaoResponseDto.code',
    // SPEC-030 acrescentou `AULA_NAO_REALIZADA`: nao se avalia aula que nao
    // aconteceu, e a nota entraria na media da turma para sempre.
    ['NAO_MATRICULADO', 'AULA_NAO_TERMINOU', 'AULA_NAO_REALIZADA'],
  ],
]);

function enumsPublicadosEmRespostas(): {
  schema: string;
  campo: string;
  valores: string[];
}[] {
  const doc = lerOpenApiCompleto();
  const saida: { schema: string; campo: string; valores: string[] }[] = [];
  for (const [nome, corpo] of Object.entries(doc.components?.schemas ?? {})) {
    if (!nome.endsWith('ResponseDto')) continue;
    for (const [campo, prop] of Object.entries(corpo.properties ?? {})) {
      if (Array.isArray(prop.enum)) {
        saida.push({ schema: nome, campo, valores: prop.enum });
      }
    }
  }
  return saida;
}

/** Os enums do `schema.prisma`, lidos do arquivo — não de uma cópia. */
function enumsDoPrisma(): Map<string, string[]> {
  const sql = readFileSync(
    join(__dirname, '..', 'prisma', 'schema.prisma'),
    'utf8',
  );
  const mapa = new Map<string, string[]>();
  const re = /^enum (\w+) \{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const valores = m[2]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('//') && !l.startsWith('@@'));
    mapa.set(m[1], valores);
  }
  return mapa;
}

describe('DEF-016 — todo enum publicado tem origem conferível', () => {
  // **Comparação por CONJUNTO, não por ordem.** No `schema.prisma` a ordem é
  // semântica — a SPEC-013 acrescentou `professor` no fim de propósito,
  // porque `ALTER TYPE ADD VALUE` sem `BEFORE`/`AFTER` anexa ao final e
  // declarar noutra posição criaria drift permanente entre schema e banco.
  // No contrato publicado a ordem não significa nada: é o conjunto de
  // valores aceitos. Comparar por ordem reprovaria `[AVULSO, TURMA]` contra
  // `[TURMA, AVULSO]` — rigor no lugar errado, que treina quem lê a ignorar
  // o teste.
  const comoConjunto = (v: string[]) => [...v].sort().join('|');
  const publicados = enumsPublicadosEmRespostas();
  const doPrisma = [...enumsDoPrisma().values()].map(comoConjunto);

  it('o schema.prisma foi lido — senão o teste abaixo passa por vacuidade', () => {
    expect(doPrisma.length).toBeGreaterThan(5);
    expect(publicados.length).toBeGreaterThan(5);
  });

  it('nenhum enum de resposta é inventado', () => {
    const orfaos = publicados.filter(({ schema, campo, valores }) => {
      const chave = comoConjunto(valores);
      if (doPrisma.includes(chave)) return false;
      // A qualificada ganha da simples: quando o nome do campo se repete
      // com significados diferentes, só ela distingue.
      const deCodigo =
        ENUMS_DE_CODIGO.get(`${schema}.${campo}`) ?? ENUMS_DE_CODIGO.get(campo);
      return !deCodigo || comoConjunto(deCodigo) !== chave;
    });

    // A mensagem precisa dizer QUAL, senão o próximo a ver isto vermelho
    // gasta a primeira meia hora descobrindo onde olhar.
    expect(
      orfaos.map((o) => `${o.schema}.${o.campo} = [${o.valores.join(', ')}]`),
    ).toEqual([]);
  });
});

/**
 * **Achado 3 da validação cruzada da SPEC-025, virado gate.**
 *
 * As três rotas de avaliação lançavam `NotFoundException` em runtime e
 * publicavam só `200`. O contrato escondia um caso que a própria spec exige,
 * e um cliente gerado do OpenAPI não enxergava a recusa.
 *
 * Isto não é caso isolado: é a mesma família da LIM-004 — o caminho de erro
 * sendo afirmação em vez de contrato. Por isso vira **gate** e não anotação:
 * o projeto já aprendeu, no DEF-016, que aviso não é mecanismo.
 *
 * **O que este gate NÃO consegue fazer**, e vale declarar: ele não descobre
 * sozinho quais rotas podem dar 404 — isso não é estático. Ele guarda a
 * lista abaixo, que cresce à mão. É uma rede menor que a ideal, e ainda
 * assim maior que nenhuma.
 */
const ROTAS_QUE_PRECISAM_DECLARAR_404: [string, string][] = [
  ['/api/v1/classes/{id}/avaliacoes', 'get'],
  ['/api/v1/me/classes/{id}/avaliacao', 'get'],
  ['/api/v1/me/classes/aulas/{ocupacaoId}/avaliacao', 'put'],
];

describe('SPEC-025 — rota que recusa por 404 publica o 404', () => {
  // `lerOpenApi()` e não `lerOpenApiCompleto()`: é este que expõe `paths`.
  // O outro devolve `components`, e usá-lo aqui foi erro meu — o `tsc`
  // pegou, que é exatamente o que ele existe para fazer.
  const doc = lerOpenApi();

  it('a lista foi lida do documento — senão o teste passa por vacuidade', () => {
    for (const [caminho, metodo] of ROTAS_QUE_PRECISAM_DECLARAR_404) {
      expect(doc.paths[caminho]?.[metodo]).toBeDefined();
    }
  });

  it('todas declaram 404', () => {
    const semDeclarar = ROTAS_QUE_PRECISAM_DECLARAR_404.filter(
      ([caminho, metodo]) =>
        !Object.keys(doc.paths[caminho]?.[metodo]?.responses ?? {}).includes(
          '404',
        ),
    ).map(([caminho, metodo]) => `${metodo.toUpperCase()} ${caminho}`);

    expect(semDeclarar).toEqual([]);
  });
});
