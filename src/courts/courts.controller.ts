import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { PaginationQueryDto } from '../people/dto/pagination-query.dto';
import { CourtsService } from './courts.service';
import { AvailabilityQueryDto } from './dto/availability-query.dto';
import { CreateCourtDto } from './dto/create-court.dto';
import { UpdateCourtDto } from './dto/update-court.dto';

// CON-005.1/005.3: leitura (list/findOne/availability) é aberta a
// `company_admin` e `aluno` (SPEC-005, app do aluno navega a mesma
// grade) — escrita (create/update) continua exclusiva de `company_admin`.
@ApiTags('courts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('courts')
export class CourtsController {
  constructor(private readonly courtsService: CourtsService) {}

  @Get()
  @Roles('company_admin', 'aluno')
  list(
    @CurrentUser() user: AccessTokenPayload,
    @Query() query: PaginationQueryDto,
  ) {
    return this.courtsService.list(
      user.companyId as string,
      query.page,
      query.pageSize,
    );
  }

  @Post()
  @Roles('company_admin')
  create(@CurrentUser() user: AccessTokenPayload, @Body() dto: CreateCourtDto) {
    return this.courtsService.create(user.companyId as string, dto);
  }

  @Get(':id')
  @Roles('company_admin', 'aluno')
  findOne(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.courtsService.findOne(user.companyId as string, id);
  }

  @Patch(':id')
  @Roles('company_admin')
  update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCourtDto,
  ) {
    return this.courtsService.update(user.companyId as string, id, dto);
  }

  @Get(':id/availability')
  @Roles('company_admin', 'aluno')
  availability(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: AvailabilityQueryDto,
  ) {
    return this.courtsService.availability(
      user.companyId as string,
      id,
      query.data,
    );
  }
}
