import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  ArgumentMetadata,
  BadRequestException,
  ValidationPipe,
} from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { MetadataScanner } from '@nestjs/core';
import { getMetadataStorage } from 'class-validator';
import { TransformationType } from 'class-transformer';
import { defaultMetadataStorage } from 'class-transformer/cjs/storage';
import { CreateBookingDto } from '../../courts/dto/create-booking.dto';
import { UpdateClassDto } from '../../classes/dto/update-class.dto';
import { UpdateCourtDto } from '../../courts/dto/update-court.dto';
import { criarValidationPipe } from './configurar-app';

/**
 * GATE — **todo UUID de CORPO passa pelo `UuidNoCorpo`.**
 *
 * ## Três versões deste arquivo já foram achado de validação cruzada
 *
 * | Rodada | O gate perguntava | Passava |
 * |---|---|---|
 * | 5ª | não há `@IsUUID()` cru no texto | **tirar** o `@UuidNoCorpo` |
 * | 5ª | `plainToInstance` normaliza | tirar o `IsUUID()` **de dentro** do decorador |
 * | 6ª | metadado, mas com `if (daProp.length === 0) continue` | tirar o decorador de campo **obrigatório** |
 *
 * O último era o pior. Campo obrigatório não tem `@IsOptional()` para sobrar:
 * tirar o `@UuidNoCorpo()` apaga TODO o metadado da propriedade, e ela sumia
 * do julgamento — o piso caía de 18 para 17 e continuava acima de 12. Em
 * produção, com `forbidNonWhitelisted`, o campo vira **desconhecido**: um
 * `PUT` de chamada perfeitamente válido responde `400 alunoId should not
 * exist`, e o professor não salva mais nada.
 *
 * ## Como ele julga agora
 *
 * **Descoberta pelo contrato, não por nome de arquivo.** Um DTO é de entrada
 * quando alguma rota REGISTRADA no `AppModule` o usa como tipo de `@Body`,
 * `@Query` ou `@Param` — mais o que for alcançável por `@Type(() => X)`
 * (`ItemChamadaDto` chega por aí). DTO de resposta não entra, porque ninguém
 * o valida; e nenhuma renomeação de arquivo ou classe tira um DTO de entrada
 * do julgamento.
 *
 * **Propriedade declarada sem metadado é violação, não silêncio.** Cada
 * propriedade em forma de id tem de ter as DUAS metades registradas:
 *
 * - `isUuid` no `class-validator`;
 * - `@Transform` no `class-transformer` — é esta que fecha o bypass por
 *   alias (`import { IsUUID as U }` registraria `isUuid` e escaparia de
 *   qualquer regex textual, mas não normaliza).
 *
 * **O limite, declarado:** isto prova *declaração*. Quem prova *resultado* é
 * `fronteira-do-uuid.http.spec.ts`, por HTTP, no app configurado como
 * produção.
 */
type Construtor = new (...args: never[]) => object;
type Modulo = new (...args: never[]) => object;

const SRC = join(__dirname, '..', '..');
const NOME_DE_ID = /^(id|.*Id)$/;
/** Fecha-chave em coluna zero: o fim de uma classe de topo. */
const FIM_DE_CLASSE = String.fromCharCode(10) + '}';

// ------------------------------------------------------------------- o fonte

function arquivosDeDtos(dir: string): string[] {
  const achados: string[] = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) {
      achados.push(...arquivosDeDtos(caminho));
    } else if (entrada.name.endsWith('.dto.ts')) {
      achados.push(caminho);
    }
  }
  return achados;
}

const PROPRIEDADE = /^ {2}([a-zA-Z][a-zA-Z0-9]*)[?!]?\s*:/gm;

/** nome da classe -> arquivo e propriedades declaradas nela. */
function indiceDoFonte(): Map<string, { arquivo: string; props: string[] }> {
  const indice = new Map<string, { arquivo: string; props: string[] }>();
  for (const arquivo of arquivosDeDtos(SRC)) {
    const fonte = readFileSync(arquivo, 'utf8');
    const inicio = /class\s+(\w+)[^{]*\{/g;
    let m: RegExpExecArray | null;
    while ((m = inicio.exec(fonte)) !== null) {
      const apos = inicio.lastIndex;
      const fim = fonte.indexOf(FIM_DE_CLASSE, apos);
      const corpo = fonte.slice(apos, fim === -1 ? undefined : fim);
      indice.set(m[1], {
        arquivo: relative(SRC, arquivo),
        props: [...corpo.matchAll(PROPRIEDADE)].map(([, nome]) => nome),
      });
    }
  }
  return indice;
}

const FONTE = indiceDoFonte();

// ----------------------------------------------------------------- descoberta

function modulosDe(raiz: Modulo): Set<Modulo> {
  const vistos = new Set<Modulo>();
  const fila: Modulo[] = [raiz];
  while (fila.length > 0) {
    const modulo = fila.pop() as Modulo;
    if (vistos.has(modulo)) continue;
    vistos.add(modulo);
    const importados =
      (Reflect.getMetadata('imports', modulo) as unknown[] | undefined) ?? [];
    for (const importado of importados) {
      const alvo =
        typeof importado === 'function'
          ? (importado as Modulo)
          : ((importado as { module?: Modulo } | null)?.module ?? null);
      if (alvo) fila.push(alvo);
    }
  }
  return vistos;
}

function controllersRegistrados(): Construtor[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AppModule } = require('../../app.module') as { AppModule: Modulo };
  const todos: Construtor[] = [];
  for (const modulo of modulosDe(AppModule)) {
    const declarados =
      (Reflect.getMetadata('controllers', modulo) as
        Construtor[] | undefined) ?? [];
    todos.push(...declarados);
  }
  return todos;
}

const ENTRADAS = new Set<number>([
  RouteParamtypes.BODY,
  RouteParamtypes.QUERY,
  RouteParamtypes.PARAM,
]);

/**
 * **Exclui primitivos, em vez de exigir o sufixo `Dto`.**
 *
 * A primeira versão desta função perguntava `/Dto$/.test(nome)` — o MESMO
 * filtro nominal que o achado 4 da 6ª rodada condenou no gate de rota,
 * sobrevivendo num lugar novo. Uma classe de entrada que não terminasse em
 * `Dto` sumiria do julgamento, e nada acusaria.
 *
 * Agora a regra é pela negativa: `design:paramtypes` devolve `String`,
 * `Number`, `Boolean`, `Object` e `Array` para o que não é classe de
 * domínio. Tudo o mais que uma rota valida como entrada é candidato — o nome
 * deixou de decidir.
 */
const PRIMITIVOS: unknown[] = [
  String,
  Number,
  Boolean,
  Object,
  Array,
  Date,
  Function,
];

const ehClasseDeEntrada = (v: unknown): v is Construtor =>
  typeof v === 'function' && !PRIMITIVOS.includes(v);

/** As classes que alguma rota registrada valida como entrada. */
function dtosDeEntrada(): Set<Construtor> {
  const achados = new Set<Construtor>();
  const fila: Construtor[] = [];

  for (const Ctor of controllersRegistrados()) {
    // **`MetadataScanner`, e não `getOwnPropertyNames` — achado 1 da 7ª
    // rodada.** É o mesmo scanner que o Nest usa para montar as rotas, e ele
    // percorre a cadeia de protótipos. `CourtSportsController` e
    // `CourtCategoriesController` herdam `update`/`remove` (com `:id`) de
    // `CatalogoController`: o gate via 56 parâmetros onde o Nest registra 60,
    // e tirar o pipe da classe-base deixava tudo verde.
    const metodos = new MetadataScanner()
      .getAllMethodNames(Ctor.prototype as object)
      .filter((m) => m !== 'constructor');
    for (const metodo of metodos) {
      const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, Ctor, metodo) as
        Record<string, { index: number }> | undefined;
      if (!args) continue;
      const tipos =
        (Reflect.getMetadata(
          'design:paramtypes',
          Ctor.prototype as object,
          metodo,
        ) as unknown[] | undefined) ?? [];

      for (const [chave, arg] of Object.entries(args)) {
        if (!ENTRADAS.has(Number(chave.split(':')[0]))) continue;
        const tipo = tipos[arg.index];
        if (ehClasseDeEntrada(tipo)) fila.push(tipo);
      }
    }
  }

  // `@Type(() => X)` — `ItemChamadaDto` chega por aqui, aninhado.
  while (fila.length > 0) {
    const Ctor = fila.pop() as Construtor;
    if (achados.has(Ctor)) continue;
    achados.add(Ctor);

    // `findTypeMetadata` não tem tipo público utilizável aqui; o que
    // interessa é só o `typeFunction`, e ele é conferido antes de chamar.
    const storageDeTipos = defaultMetadataStorage as unknown as {
      findTypeMetadata: (
        alvo: unknown,
        prop: string,
      ) => { typeFunction?: () => unknown } | undefined;
    };
    for (const prop of FONTE.get(Ctor.name)?.props ?? []) {
      const aninhado = storageDeTipos
        .findTypeMetadata(Ctor, prop)
        ?.typeFunction?.();
      if (ehClasseDeEntrada(aninhado)) fila.push(aninhado);
    }
  }
  return achados;
}

// -------------------------------------------------------------------- o gate

interface PropDeId {
  rotulo: string;
  temIsUuid: boolean;
  temTransform: boolean;
}

/**
 * Há `@Transform` que **roda na entrada** para esta propriedade?
 *
 * ## O achado 2 da 7ª rodada, e por que meu argumento estava errado
 *
 * A versão anterior lia `_transformMetadatas` direto e aceitava **qualquer**
 * entrada no mapa. Bastava isto para ficar verde sem normalizar nada:
 *
 * ```ts
 * @IsUUID()
 * @Transform(({ value }) => value, { toPlainOnly: true })
 * alunoId!: string;
 * ```
 *
 * `isUuid` presente, transform presente, gate verde — e o transform **não
 * roda em `PLAIN_TO_CLASS`**. Um `alunoId` em maiúsculas chegava cru ao
 * `presenca.service.ts` e virava `422 ALUNO_FORA_DA_TURMA`.
 *
 * Eu tinha escrito no comentário anterior que ler API interna "falha
 * fechada". **Não falha:** já havia falso positivo, sem upgrade nenhum.
 * Afirmação minha sobre segurança de um mecanismo, outra vez errada.
 *
 * `findTransformMetadatas(alvo, propriedade, tipo)` é justamente a API que
 * filtra `toPlainOnly`/`toClassOnly` — a chamada anterior devolvia vazio
 * porque eu passava `undefined` no lugar da propriedade. Ela também resolve
 * ancestrais sozinha, então a subida manual pela cadeia de protótipos sai:
 * `PartialType` copia os metadados com `inheritTransformationMetadata`, e
 * não depende de herança.
 */
function temTransformDeEntrada(Ctor: Construtor, propriedade: string): boolean {
  return (
    (
      defaultMetadataStorage as unknown as {
        findTransformMetadatas: (
          alvo: unknown,
          propriedade: string,
          tipo: TransformationType,
        ) => unknown[];
      }
    ).findTransformMetadatas(
      Ctor,
      propriedade,
      TransformationType.PLAIN_TO_CLASS,
    ).length > 0
  );
}

function propriedadesDeId(): PropDeId[] {
  const storage = getMetadataStorage();
  const todas: PropDeId[] = [];

  for (const Ctor of dtosDeEntrada()) {
    const doFonte = FONTE.get(Ctor.name);
    if (!doFonte) continue;

    const metadados = storage.getTargetValidationMetadatas(
      Ctor,
      Ctor.name,
      true,
      false,
    );

    for (const nome of doFonte.props) {
      if (!NOME_DE_ID.test(nome)) continue;
      const daProp = metadados.filter((m) => m.propertyName === nome);

      // **Sem `continue` quando não há metadado.** Propriedade declarada num
      // DTO de entrada e sem `isUuid` é violação, tenha ela outros
      // decoradores ou nenhum — foi assim que o campo obrigatório escapou.
      todas.push({
        rotulo: `${doFonte.arquivo} :: ${Ctor.name}.${nome}`,
        temIsUuid: daProp.some((m) => m.name === 'isUuid'),
        temTransform: temTransformDeEntrada(Ctor, nome),
      });
    }
  }
  return todas;
}

describe('gate: a fronteira do UUID de CORPO está declarada', () => {
  const dtos = dtosDeEntrada();
  const props = propriedadesDeId();

  it('a descoberta acha os DTOs de entrada pelo contrato das rotas', () => {
    expect(dtos.size).toBeGreaterThan(10);
    expect(props.length).toBeGreaterThan(12);
    // `ItemChamadaDto` só é alcançável por `@Type(() => …)`. Se a travessia
    // de aninhados quebrar ele some — e foi ele o exemplo do achado.
    expect([...dtos].map((d) => d.name)).toContain('ItemChamadaDto');
  });

  it('toda propriedade de id tem `isUuid` REGISTRADO', () => {
    const violacoes = props.filter((p) => !p.temIsUuid).map((p) => p.rotulo);
    expect(violacoes).toEqual([]);
  });

  it('e toda propriedade de id tem o `@Transform` REGISTRADO', () => {
    // `@IsUUID()` cru — ou importado com alias, que driblava a regex textual
    // da versão anterior — registra `isUuid` e **não normaliza**. As duas
    // metades do decorador composto precisam aparecer no registro.
    const violacoes = props.filter((p) => !p.temTransform).map((p) => p.rotulo);
    expect(violacoes).toEqual([]);
  });
});

/**
 * As provas de comportamento. Rodam o `ValidationPipe` da **fábrica que o
 * `configurarApp` usa** — `plainToInstance` sozinho executa `Transform` e não
 * executa validação, e foi assim que a metade `IsUUID` ficou sem prova.
 */
describe('`UuidNoCorpo` — as DUAS metades, pelo pipe de produção', () => {
  const pipe = criarValidationPipe();
  const MISTO = 'AAAAaaaa-BBBB-4ccc-8DDD-eeeeFFFF0011';
  const CANONICO = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0011';

  const meta = (metatype: unknown): ArgumentMetadata =>
    ({ type: 'body', metatype }) as ArgumentMetadata;

  const booking = (quadraId: unknown) => ({
    quadraId,
    data: '2026-09-01',
    slots: [{ horaInicio: '08:00', horaFim: '09:00' }],
  });

  it('metade 1 — normaliza: grafia mista chega canônica ao handler', async () => {
    const dto = (await pipe.transform(
      booking(MISTO),
      meta(CreateBookingDto),
    )) as CreateBookingDto;

    expect(dto.quadraId).toBe(CANONICO);
  });

  it('metade 2 — valida: valor que não é UUID vira 400', async () => {
    await expect(
      pipe.transform(booking('not-a-uuid'), meta(CreateBookingDto)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // O campo da sabotagem do achado 2 da 5ª rodada: o `@IsOptional()` o
  // mantinha na whitelist enquanto ele deixara de ter restrição de tipo.
  it('campo OPCIONAL de id também é validado (`UpdateClassDto.professorId`)', async () => {
    await expect(
      pipe.transform({ professorId: 'not-a-uuid' }, meta(UpdateClassDto)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('e o mesmo campo opcional, válido e em caixa alta, chega canônico', async () => {
    const dto = (await pipe.transform(
      { professorId: MISTO },
      meta(UpdateClassDto),
    )) as UpdateClassDto;

    expect(dto.professorId).toBe(CANONICO);
  });

  // `UpdateCourtDto.categoriaId` é `string | null` com `ValidateIf`, para o
  // clube conseguir DESCLASSIFICAR uma quadra. Um `.toLowerCase()` seco
  // quebraria a rota com `TypeError`, e nenhum gate de declaração veria.
  it('`null` atravessa intacto — desclassificar continua possível', async () => {
    const dto = (await pipe.transform(
      { categoriaId: null },
      meta(UpdateCourtDto),
    )) as UpdateCourtDto;

    expect(dto.categoriaId).toBeNull();
  });

  it('campo opcional ausente continua ausente', async () => {
    const dto = (await pipe.transform(
      {},
      meta(UpdateCourtDto),
    )) as UpdateCourtDto;
    expect(dto.categoriaId).toBeUndefined();
  });

  /**
   * **O mecanismo, medido em vez de suposto.**
   *
   * Declarei na 5ª rodada que a fronteira dependia de `transform: true`.
   * **Falso.** Só a configuração inteiramente padrão (`{}`) perde a
   * normalização, porque o `ValidationPipe` devolve `classToPlain(entity)`
   * sempre que `validatorOptions` não está vazio.
   *
   * É a única coisa no projeto que registra por que a configuração não pode
   * encolher — e `configurarApp` é o lugar único onde ela pode mudar.
   */
  it('a configuração VAZIA perderia a normalização — é o que a fábrica impede', async () => {
    const semConfig = new ValidationPipe({});

    const cru = (await semConfig.transform(
      booking(MISTO),
      meta(CreateBookingDto),
    )) as CreateBookingDto;
    expect(cru.quadraId).toBe(MISTO);

    const pelaFabrica = (await pipe.transform(
      booking(MISTO),
      meta(CreateBookingDto),
    )) as CreateBookingDto;
    expect(pelaFabrica.quadraId).toBe(CANONICO);
  });
});
