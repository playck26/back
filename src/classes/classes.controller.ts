import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import { ClassesService } from './classes.service';
import { CreateClassDto } from './dto/create-class.dto';
import { UpdateClassDto } from './dto/update-class.dto';

// Escopo desta spec (SPEC-003, fatia de turmas): UI só existe em `admin`
// (TASK-006) — guard restrito a company_admin. CON-004.1 documenta
// leitura por `aluno` também; estendido quando SPEC-005 (app do aluno)
// precisar (CON-004.5-7, fora do escopo desta spec).
@ApiTags('classes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyAdminGuard)
@Controller('classes')
export class ClassesController {
  constructor(private readonly classesService: ClassesService) {}

  @Get()
  list(
    @CurrentUser() user: AccessTokenPayload,
    @Query() query: PaginationQueryDto,
  ) {
    return this.classesService.list(user.companyId as string, query);
  }

  @Post()
  create(@CurrentUser() user: AccessTokenPayload, @Body() dto: CreateClassDto) {
    return this.classesService.create(user.companyId as string, dto);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.classesService.findOne(user.companyId as string, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateClassDto,
  ) {
    return this.classesService.update(user.companyId as string, id, dto);
  }

  @Post(':id/students/:alunoId')
  allocateStudent(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('alunoId', ParseUUIDPipe) alunoId: string,
  ) {
    return this.classesService.allocateStudent(
      user.companyId as string,
      id,
      alunoId,
    );
  }

  @Delete(':id/students/:alunoId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeStudent(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('alunoId', ParseUUIDPipe) alunoId: string,
  ) {
    return this.classesService.removeStudent(
      user.companyId as string,
      id,
      alunoId,
    );
  }
}
