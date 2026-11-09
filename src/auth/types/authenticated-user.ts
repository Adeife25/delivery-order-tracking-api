import { UserRole } from '../../generated/prisma/enums';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
}

export interface TokenSubject {
  id: string;
  email: string;
  role: UserRole;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AccessJwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  type: 'access';
}

export interface RefreshJwtPayload {
  sub: string;
  type: 'refresh';
  jti?: string;
}
