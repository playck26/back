import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsUUID } from 'class-validator';

/**
 * **A fronteira do UUID que chega no CORPO — irmã do `UuidCanonicoPipe`.**
 *
 * `@IsUUID()` confere o formato e **devolve a grafia que veio**. O Postgres
 * responde sempre na forma canônica minúscula. Toda comparação em TypeScript
 * entre um UUID de corpo e um do banco é, por isso, uma comparação entre duas
 * GRAFIAS do mesmo valor.
 *
 * ## Por que isto existe, e o que custou chegar aqui
 *
 * Eu afirmei **duas vezes** que não havia comparação assim no projeto. As
 * duas vezes estava errado:
 *
 * 1. na primeira, a planta dizia *"nenhuma comparação entre UUID de body e
 *    UUID de banco existe hoje"* — e havia `resolverDeLinhas` e o
 *    `TenantGuard`;
 * 2. na segunda, eu disse "os dois sítios que existem hoje foram fechados no
 *    ponto de comparação" — e a 4ª validação cruzada achou o terceiro, na
 *    impressão digital da idempotência de reserva: o mesmo pedido reenviado
 *    com o UUID em outra grafia virava `422 IDEMPOTENCY_KEY_REUSED` em vez
 *    de devolver a reserva original.
 *
 * **Duas afirmações de completude, duas erradas.** Enquanto a garantia
 * depender de alguém varrer o projeto e não deixar sítio passar, ela vai
 * falhar de novo — a varredura é o método que já falhou duas vezes.
 *
 * Por isso a normalização mudou de lugar: sai do ponto de comparação (que
 * exige achar todos) e vai para a **entrada** (que não exige achar nenhum).
 * Depois deste decorador, um UUID de corpo chega ao serviço na mesma grafia
 * em que o banco responde, e a comparação deixa de ser um lugar onde dá para
 * errar.
 *
 * O gate `uuid-no-corpo.gate.spec.ts` recusa `@IsUUID()` cru em DTO — sem
 * ele, o próximo campo nasceria fora da garantia e ninguém saberia.
 *
 * **`null` e `undefined` passam intactos.** `UpdateCourtDto.categoriaId` é
 * `string | null` com `ValidateIf` justamente para o clube conseguir
 * desclassificar uma quadra; um `.toLowerCase()` seco ali quebraria essa
 * rota.
 */
export function UuidNoCorpo(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.toLowerCase() : value,
    ),
    IsUUID(),
  );
}
