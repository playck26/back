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
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CompanyAdminGuard } from '../common/guards/company-admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { NivelResponseDto } from './dto/people-response.dto';
import { CreateLevelDto } from './dto/create-level.dto';
import { UpdateLevelDto } from './dto/update-level.dto';
import { LevelsService } from './levels.service';

@ApiTags('levels')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyAdminGuard)
@Controller('levels')
export class LevelsController {
  constructor(private readonly levelsService: LevelsService) {}

  @Get()
  @ApiOkResponse({ type: [NivelResponseDto] })
  list(@CurrentUser() user: AccessTokenPayload) {
    return this.levelsService.list(user.companyId as string);
  }

  @Post()
  @ApiCreatedResponse({ type: NivelResponseDto })
  create(@CurrentUser() user: AccessTokenPayload, @Body() dto: CreateLevelDto) {
    return this.levelsService.create(user.companyId as string, dto);
  }

  @Patch(':id')
  @ApiOkResponse({ type: NivelResponseDto })
  update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLevelDto,
  ) {
    return this.levelsService.update(user.companyId as string, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.levelsService.remove(user.companyId as string, id);
  }
}
