import {
  Injectable,
  ParseUUIDPipe,
  type ArgumentMetadata,
} from '@nestjs/common';

/**
 * **SPEC-030 / achado 1 da 3ª validação cruzada (MÉDIA) — UUID não é texto,
 * e quem tem de saber disso é a fronteira.**
 *
 * `ParseUUIDPipe` confere o formato e **devolve o que veio**: `A000…001`
 * passa com as maiúsculas intactas. Do outro lado, a coluna é `uuid` e o
 * Postgres devolve sempre a forma canônica minúscula. Toda comparação em
 * TypeScript entre um id de rota e um id do banco é, portanto, uma
 * comparação entre duas GRAFIAS do mesmo valor — e `!==` diz que são
 * diferentes.
 *
 * O caso que apareceu foi o portão de `nao-houve`: o gestor abria
 * `PUT /classes/A000…001/presencas/:ocupacaoId/nao-houve` e levava `404` na
 * própria turma. Mas o defeito nunca foi daquele `if`. Havia outros iguais,
 * cada um com um sintoma próprio — renomear empresa ou nível para o próprio
 * nome acusando "já existe", o `companyId` do ator contra o da URL negando
 * acesso legítimo, filtros por `quadraId` devolvendo lista vazia.
 *
 * Por isso a correção mora aqui: **depois deste pipe, todo `@Param` de UUID
 * do projeto chega na mesma grafia em que o banco responde.** Corrigir cada
 * `if` seria consertar as sombras e deixar a luz onde estava.
 *
 * Não perde informação. UUID é hexadecimal, e minúsculo é a forma canônica
 * da RFC 4122 (§3: a saída é gerada em minúsculas, a entrada é aceita nas
 * duas). `A` e `a` são o mesmo nibble — normalizar é escolher a grafia, não
 * mudar o valor.
 *
 * **O que este pipe NÃO cobre:** UUID que chega em body ou query, validado
 * por `class-validator` (`@IsUUID()`), continua com a grafia original. Não é
 * descuido não estendido aqui — é que o defeito conhecido é de `@Param`, e
 * ampliar sem caso concreto criaria uma segunda regra para manter. Quem
 * comparar um UUID de body com um do banco: normalize, ou traga o caso.
 */
@Injectable()
export class UuidCanonicoPipe extends ParseUUIDPipe {
  async transform(value: string, metadata: ArgumentMetadata): Promise<string> {
    // `super` primeiro: id malformado continua sendo `400` antes de qualquer
    // consulta, que é o motivo de o `ParseUUIDPipe` estar nas rotas.
    return (await super.transform(value, metadata)).toLowerCase();
  }
}
