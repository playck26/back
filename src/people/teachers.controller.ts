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
import { CreateTeacherDto } from './dto/create-teacher.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';
import { UpdateTeacherDto } from './dto/update-teacher.dto';
import { TeachersService } from './teachers.service';

@ApiTags('teachers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyAdminGuard)
@Controller('teachers')
export class TeachersController {
  constructor(private readonly teachersService: TeachersService) {}

  @Get()
  list(
    @CurrentUser() user: AccessTokenPayload,
    @Query() query: PaginationQueryDto,
  ) {
    return this.teachersService.list(user.companyId as string, query);
  }

  @Post()
  create(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: CreateTeacherDto,
  ) {
    return this.teachersService.create(user.companyId as string, dto);
  }

  /**
   * SPEC-013 — cria (ou rotaciona) o acesso do professor. `POST` e nao
   * `PATCH` porque o efeito e gerar uma credencial nova, nao editar um
   * campo: chamar duas vezes tem consequencia real (a senha anterior para
   * de valer), e o verbo precisa avisar isso.
   */
  @Post(':id/acesso')
  gerarAcesso(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.teachersService.gerarAcesso(user.companyId as string, id);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.teachersService.findOne(user.companyId as string, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTeacherDto,
  ) {
    return this.teachersService.update(user.companyId as string, id, dto);
  }
}
