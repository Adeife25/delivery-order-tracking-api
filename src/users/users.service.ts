import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { User, UserRole } from '../generated/prisma/client';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { publicUserSelect, PublicUser } from './users.select';

interface CreateCustomerInput {
  fullName: string;
  email: string;
  passwordHash: string;
  phoneNumber?: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async createCustomer(input: CreateCustomerInput): Promise<PublicUser> {
    return this.prisma.user.create({
      data: {
        fullName: input.fullName,
        email: input.email,
        passwordHash: input.passwordHash,
        phoneNumber: input.phoneNumber,
        role: UserRole.CUSTOMER,
      },
      select: publicUserSelect,
    });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email },
    });
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { id },
    });
  }

  async getProfile(id: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: publicUserSelect,
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async updateProfile(id: string, dto: UpdateProfileDto): Promise<PublicUser> {
    if (dto.fullName === undefined && dto.phoneNumber === undefined) {
      return this.getProfile(id);
    }

    const user = await this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.fullName !== undefined && { fullName: dto.fullName }),
        ...(dto.phoneNumber !== undefined && {
          phoneNumber: dto.phoneNumber,
        }),
      },
      select: publicUserSelect,
    });

    return user;
  }
}
