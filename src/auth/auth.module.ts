import { Module } from '@nestjs/common';
import { PeopleModule } from '../people/people.module';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAccessStrategy } from './strategies/jwt-access.strategy';

@Module({
  imports: [PassportModule, JwtModule.register({}), PeopleModule],
  controllers: [AuthController],
  providers: [AuthService, JwtAccessStrategy],
  exports: [AuthService],
})
export class AuthModule {}
