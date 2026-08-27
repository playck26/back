import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /**
   * SPEC-021/TASK-005 — **o corpo aqui é uma string, não um objeto.**
   *
   * O levantamento inicial descreveu esta rota como "objeto sem campos" —
   * ou seja, `{}`. A refutação mostrou que não: `getHello()` devolve
   * `'Hello World!'`, e o adaptador do Express desvia string para `send()`
   * em vez de `json()`, com `Content-Type: text/html`.
   *
   * Por isso `type: String` — declarar um DTO vazio publicaria um contrato
   * que descreve outra coisa, e ninguém desconfia de schema publicado.
   */
  @Get()
  @ApiOkResponse({ type: String })
  getHello(): string {
    return this.appService.getHello();
  }
}
