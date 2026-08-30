import { BadRequestException, type ArgumentMetadata } from '@nestjs/common';
import { UuidCanonicoPipe } from './uuid-canonico.pipe';

/**
 * TEST — **a fronteira do achado 1 da 3ª validação cruzada.**
 *
 * O sintoma foi um `404` no portão de `nao-houve`, e o portão tem prova
 * própria. Esta suíte julga a CAUSA: `ParseUUIDPipe` devolvia a grafia que
 * veio da URL, e o Postgres responde sempre na forma canônica minúscula —
 * duas grafias do mesmo valor chegando a um `!==`.
 *
 * As provas usam UUID **com letra hexadecimal** de propósito. `1111…` não
 * tem caixa alta: uma prova montada sobre ele passaria sem exercitar nada,
 * que foi exatamente como o defeito atravessou a suíte da primeira vez.
 */
const META: ArgumentMetadata = { type: 'param', data: 'id' };

const MINUSCULO = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0011';

describe('UuidCanonicoPipe', () => {
  const pipe = new UuidCanonicoPipe();

  it('MAIÚSCULAS viram a forma canônica do banco', async () => {
    await expect(pipe.transform(MINUSCULO.toUpperCase(), META)).resolves.toBe(
      MINUSCULO,
    );
  });

  it('grafia mista também', async () => {
    await expect(
      pipe.transform('AAAAaaaa-BBBB-4ccc-8DDD-eeeeFFFF0011', META),
    ).resolves.toBe(MINUSCULO);
  });

  it('quem já vem canônico passa intacto', async () => {
    await expect(pipe.transform(MINUSCULO, META)).resolves.toBe(MINUSCULO);
  });

  // O pipe herda de `ParseUUIDPipe` e não pode perder o que ele fazia: id
  // malformado continua sendo `400` **antes** de qualquer consulta. Sem esta
  // prova, um `transform` que só normalizasse (e nunca validasse) passaria
  // nas três acima e abriria o banco para lixo vindo da URL.
  it('id malformado continua sendo 400, e não vira minúsculo', async () => {
    await expect(pipe.transform('nao-e-uuid', META)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('string vazia também é 400', async () => {
    await expect(pipe.transform('', META)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
