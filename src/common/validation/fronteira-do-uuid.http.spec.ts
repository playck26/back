import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { UuidCanonicoPipe } from '../pipes/uuid-canonico.pipe';
import { UuidNoCorpo } from './uuid-no-corpo.decorator';
import { configurarApp } from './configurar-app';

/**
 * **A prova HTTP da fronteira do UUID — o degrau que faltava.**
 *
 * ## Por que ela existe
 *
 * A 6ª validação cruzada desenhou a escada em que o mesmo defeito vinha
 * subindo, rodada após rodada:
 *
 * > `fonte → metadado → descoberta → composição dos pipes → bootstrap
 * > efetivo → HTTP`
 *
 * Os gates pararam no segundo degrau. Metadado prova **configuração
 * declarada** e não prova **comportamento composto**: um pipe presente pode
 * não normalizar (subclasse que sobrescreve `transform`), pode ser desfeito
 * por outro pipe adiante na cadeia — o gate usa `.some()`, o Nest executa em
 * sequência —, e a configuração global pode nem ser a que a fábrica produz.
 *
 * Esta suíte julga o único degrau que resume todos: **o que o handler
 * recebe**, num app montado por `configurarApp` — a mesma função que o
 * `main.ts` chama. Ela derruba, de uma vez:
 *
 * - subclasse do pipe que não normalize (achado 2);
 * - segundo pipe que reverta a grafia (achado 2);
 * - `new ValidationPipe({})` no bootstrap (achado 3);
 * - `@UuidNoCorpo` removido de um DTO (achado 1).
 *
 * ## Por que um controller de mentira, e não uma rota real
 *
 * Uma rota real arrastaria guards, Prisma e regra de domínio para dentro de
 * uma prova que julga fronteira. O que precisa ser real aqui é **a
 * configuração do app** e **os dois decoradores** — e os três são os de
 * produção, importados, sem dublê.
 *
 * O preço está declarado: esta suíte prova que a fronteira FUNCIONA, não que
 * ela está aplicada em toda rota. Quem prova cobertura são os dois gates. As
 * duas metades fazem falta, e nenhuma substitui a outra.
 */
class CorpoComUuidDto {
  @UuidNoCorpo()
  alunoId!: string;
}

@Controller('fronteira')
class FronteiraDeTesteController {
  @Get('rota/:alunoId')
  daRota(@Param('alunoId', UuidCanonicoPipe) alunoId: string) {
    // Devolve o que CHEGOU. É o objeto do julgamento: não interessa qual
    // pipe está declarado, interessa o valor que o handler viu.
    return { recebido: alunoId };
  }

  @Post('corpo')
  doCorpo(@Body() dto: CorpoComUuidDto) {
    return { recebido: dto.alunoId };
  }
}

const MISTO = 'AAAAaaaa-BBBB-4ccc-8DDD-eeeeFFFF0011';
const CANONICO = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0011';

describe('fronteira do UUID, por HTTP, no app configurado como produção', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FronteiraDeTesteController],
    }).compile();

    app = moduleRef.createNestApplication<INestApplication<App>>();
    // A MESMA função do `main.ts`. Trocar a configuração lá derruba isto.
    configurarApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const url = (caminho: string) => `/api/v1/fronteira${caminho}`;

  it('UUID misto na ROTA chega canônico ao handler', async () => {
    const res = await request(app.getHttpServer())
      .get(url(`/rota/${MISTO}`))
      .expect(200);

    expect(res.body).toEqual({ recebido: CANONICO });
  });

  it('UUID misto no CORPO chega canônico ao handler', async () => {
    const res = await request(app.getHttpServer())
      .post(url('/corpo'))
      .send({ alunoId: MISTO })
      .expect(201);

    expect(res.body).toEqual({ recebido: CANONICO });
  });

  // Os pares negativos. Sem eles, uma fronteira que devolvesse minúsculas
  // para qualquer entrada — inclusive lixo — passaria nas duas acima.
  it('valor que não é UUID na rota é 400, e não chega ao handler', async () => {
    await request(app.getHttpServer()).get(url('/rota/nao-e-uuid')).expect(400);
  });

  it('valor que não é UUID no corpo é 400', async () => {
    await request(app.getHttpServer())
      .post(url('/corpo'))
      .send({ alunoId: 'nao-e-uuid' })
      .expect(400);
  });

  /**
   * **O achado 1 da 6ª rodada, no degrau em que ele dói.**
   *
   * Tirar `@UuidNoCorpo()` de um campo obrigatório não deixa o campo sem
   * validação: com `forbidNonWhitelisted`, ele passa a ser **campo
   * desconhecido**, e um pedido perfeitamente válido vira
   * `400 alunoId should not exist`. Foi o cenário do revisor com
   * `ItemChamadaDto.alunoId`: o professor deixaria de conseguir salvar
   * qualquer chamada.
   *
   * Esta prova fixa o contrato do caminho feliz — corpo válido responde
   * `201` —, que é exatamente o que aquela sabotagem quebra.
   */
  it('campo de UUID declarado é aceito, e não recusado como desconhecido', async () => {
    const res = await request(app.getHttpServer())
      .post(url('/corpo'))
      .send({ alunoId: CANONICO })
      .expect(201);

    expect(res.body).toEqual({ recebido: CANONICO });
  });

  it('campo realmente desconhecido continua sendo 400', async () => {
    // O par do anterior: `forbidNonWhitelisted` tem de continuar valendo.
    await request(app.getHttpServer())
      .post(url('/corpo'))
      .send({ alunoId: CANONICO, inventado: 1 })
      .expect(400);
  });
});
