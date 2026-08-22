import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CompanyAdminGuard } from '../common/guards/company-admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { CriarConviteDto } from './dto/criar-convite.dto';
import { InvitesService } from './invites.service';

// NFR-001: mesma política do login para superfície pública.
const PUBLICO_THROTTLE = { default: { limit: 10, ttl: 900_000 } };

@ApiTags('invites')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyAdminGuard)
@Controller('invites')
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Post()
  criar(@CurrentUser() user: AccessTokenPayload, @Body() dto: CriarConviteDto) {
    return this.invites.criar(user.companyId as string, user.sub, dto);
  }
}

@ApiTags('invites')
@Controller('public/invites')
export class PublicInvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Get(':token')
  @Throttle(PUBLICO_THROTTLE)
  consultar(@Param('token') token: string) {
    return this.invites.consultarPublico(token);
  }
}
