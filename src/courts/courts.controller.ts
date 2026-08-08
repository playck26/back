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
import { CompanyAdminGuard } from '../common/guards/company-admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { PaginationQueryDto } from '../people/dto/pagination-query.dto';
import { CourtsService } from './courts.service';
import { AvailabilityQueryDto } from './dto/availability-query.dto';
import { CreateCourtDto } from './dto/create-court.dto';
import { UpdateCourtDto } from './dto/update-court.dto';

// Escopo desta spec (SPEC-004): UI só existe em `admin` (TASK-006) — guard
// restrito a company_admin. CON-005.1 documenta leitura por `aluno`
// também; isso é estendido quando SPEC-005 (app do aluno) precisar.
@ApiTags('courts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyAdminGuard)
@Controller('courts')
export class CourtsController {
  constructor(private readonly courtsService: CourtsService) {}

  @Get()
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
  create(@CurrentUser() user: AccessTokenPayload, @Body() dto: CreateCourtDto) {
    return this.courtsService.create(user.companyId as string, dto);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.courtsService.findOne(user.companyId as string, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCourtDto,
  ) {
    return this.courtsService.update(user.companyId as string, id, dto);
  }

  @Get(':id/availability')
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
