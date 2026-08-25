import { Module } from '@nestjs/common';
import { PeopleModule } from '../people/people.module';
import { StorageModule } from '../storage/storage.module';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import {
  InvitesController,
  PublicInvitesController,
} from './invites.controller';
import { InvitesService } from './invites.service';
import { FotoDePerfilService } from './foto-de-perfil.service';
import { MeFotoController } from './me-foto.controller';
import { JwtAccessStrategy } from './strategies/jwt-access.strategy';

@Module({
  // `StorageModule` entra por causa da foto de perfil (SPEC-018/TASK-003):
  // MOD-001 é dono de `usuarios`, e `usuarios.foto_key` mora ali.
  imports: [
    PassportModule,
    JwtModule.register({}),
    PeopleModule,
    StorageModule,
  ],
  controllers: [
    AuthController,
    InvitesController,
    PublicInvitesController,
    MeFotoController,
  ],
  providers: [
    AuthService,
    InvitesService,
    JwtAccessStrategy,
    FotoDePerfilService,
  ],
  exports: [AuthService],
})
export class AuthModule {}
