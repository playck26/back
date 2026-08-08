import { DocumentBuilder } from '@nestjs/swagger';

// Contrato compartilhado poly-repo (ADR-001): admin/cliente/sadmin geram
// tipos TypeScript a partir deste documento, sem pacote publicado.
export function buildSwaggerConfig() {
  return new DocumentBuilder()
    .setTitle('PlayCK API')
    .setDescription(
      'Contrato da API do back — fonte para geração de tipos nos 3 frontends (ADR-001)',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
}
