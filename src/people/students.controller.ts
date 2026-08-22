import {
  Body,
  Controller,
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
import { CreateStudentDto } from './dto/create-student.dto';
import { ListStudentsQueryDto } from './dto/list-students-query.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { StudentsService } from './students.service';

@ApiTags('students')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyAdminGuard)
@Controller('students')
export class StudentsController {
  constructor(private readonly studentsService: StudentsService) {}

  // `?vinculo=pendente` é a fila de aprovação do admin (SPEC-009/AC-015).
  @Get()
  list(
    @CurrentUser() user: AccessTokenPayload,
    @Query() query: ListStudentsQueryDto,
  ) {
    return this.studentsService.list(user.companyId as string, query);
  }

  // SPEC-009/REQ-008: decidir sobre um cadastro é ação exclusiva do
  // `company_admin` da própria empresa — a autorização já vem dos guards
  // deste controller (AC-016).
  // SPEC-009/REQ-005: substituto oficial do "esqueci minha senha" enquanto
  // não houver e-mail transacional (GAP-004, ADR-013).
  @Post(':id/senha-temporaria')
  @HttpCode(HttpStatus.OK)
  regenerarSenhaTemporaria(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.studentsService.regenerarSenhaTemporaria(
      user.companyId as string,
      id,
    );
  }

  @Post(':id/aprovar')
  @HttpCode(HttpStatus.OK)
  aprovar(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.studentsService.decidirVinculo(
      user.companyId as string,
      id,
      'aprovado',
    );
  }

  @Post(':id/recusar')
  @HttpCode(HttpStatus.OK)
  recusar(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.studentsService.decidirVinculo(
      user.companyId as string,
      id,
      'recusado',
    );
  }

  @Post()
  create(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: CreateStudentDto,
  ) {
    return this.studentsService.create(user.companyId as string, dto);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.studentsService.findOne(user.companyId as string, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStudentDto,
  ) {
    return this.studentsService.update(user.companyId as string, id, dto);
  }
}
