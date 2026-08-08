import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CompanyAdminGuard } from '../common/guards/company-admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { CourtsService } from './courts.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { ListBookingsQueryDto } from './dto/list-bookings-query.dto';

// Escopo desta spec (SPEC-004): UI só existe em `admin` — guard restrito a
// company_admin. CON-005.4/005.6 documentam `aluno` reservando/cancelando
// para si; estendido quando SPEC-005 (app do aluno) precisar.
@ApiTags('bookings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyAdminGuard)
@Controller('bookings')
export class BookingsController {
  constructor(private readonly courtsService: CourtsService) {}

  @Post()
  create(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: CreateBookingDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.courtsService.createBooking(
      user.companyId as string,
      dto,
      idempotencyKey,
    );
  }

  @Get()
  list(
    @CurrentUser() user: AccessTokenPayload,
    @Query() query: ListBookingsQueryDto,
  ) {
    return this.courtsService.listBookings(user.companyId as string, query);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  cancel(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.courtsService.cancelBooking(user.companyId as string, id);
  }
}
