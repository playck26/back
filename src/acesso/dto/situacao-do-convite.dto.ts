import { ApiProperty } from '@nestjs/swagger';
import {
  MOTIVOS_DA_SITUACAO,
  SITUACOES_DO_CONVITE,
  type MotivoDaSituacao,
  type SituacaoDoConvite,
} from '../acesso.service';

/**
 * SPEC-083/D9 — a situação do convite na ficha do aluno e na do professor:
 * `GET` e `POST /students/:id/convite-de-acesso` (e, na parte do professor,
 * `/teachers/:id/convite-de-acesso`).
 *
 * **Rota própria, e não um campo no DTO do aluno:** o DTO do aluno é o das
 * listas, e a situação custaria uma leitura por linha.
 */
export class SituacaoDoConviteResponseDto {
  /**
   * | situação | quando | botão |
   * |---|---|---|
   * | `ativado` | a pessoa tem senha própria | nenhum |
   * | `sem_conta` | professor sem conta | enviar (exige e-mail na ficha) |
   * | `nao_enviado` | nenhum convite vivo que ainda valha | enviar |
   * | `enviado` | vivo, no prazo, aceito pelo provedor | reenviar |
   * | `falhou` | vivo, no prazo, recusado ou sem confirmação | reenviar |
   * | `expirado` | vivo, fora do prazo | reenviar |
   */
  @ApiProperty({
    type: String,
    enum: SITUACOES_DO_CONVITE,
    example: 'enviado',
  })
  situacao!: SituacaoDoConvite;

  /**
   * O instante do envio (ou da tentativa que falhou), ou o da ativação pelo
   * link. Nulo quando não há: nunca enviado, `sem_confirmacao`, ou a senha
   * criada pela troca da senha temporária, que não deixa instante.
   */
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  em!: Date | null;

  /** A validade do convite vivo; nulo sem convite vivo. */
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiraEm!: Date | null;

  /**
   * Só em `falhou`. `sem_confirmacao` é o convite que nunca recebeu resultado:
   * o processo caiu entre gravar o convite e gravar o envio (D8). **`enviado`
   * quer dizer aceito pelo provedor, e não entregue** (LIM-083a).
   */
  @ApiProperty({
    type: String,
    enum: MOTIVOS_DA_SITUACAO,
    nullable: true,
  })
  motivo!: MotivoDaSituacao | null;
}
