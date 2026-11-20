import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { UserRole } from '../database/enums';
import { UserModel } from '../database/models';
import { PublicUser, UserDoc, toPublicUser } from '../database/views';
import { USER_PUBLIC_FIELDS } from '../database/populate';
import { UpdateProfileDto } from './dto/update-profile.dto';

interface CreateCustomerInput {
  fullName: string;
  email: string;
  passwordHash: string;
  phoneNumber?: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly database: DatabaseService) {}

  async createCustomer(input: CreateCustomerInput): Promise<PublicUser> {
    const user = await UserModel.create({
      fullName: input.fullName,
      email: input.email,
      passwordHash: input.passwordHash,
      phoneNumber: input.phoneNumber ?? null,
      role: UserRole.CUSTOMER,
    });

    return toPublicUser(user.toObject() as unknown as UserDoc);
  }

  async findByEmail(email: string): Promise<UserDoc | null> {
    return (await UserModel.findOne({
      email,
    }).lean()) as unknown as UserDoc | null;
  }

  async findById(id: string): Promise<UserDoc | null> {
    return (await UserModel.findById(id).lean()) as unknown as UserDoc | null;
  }

  async getProfile(id: string): Promise<PublicUser> {
    const user = (await UserModel.findById(id)
      .select(USER_PUBLIC_FIELDS)
      .lean()) as unknown as UserDoc | null;

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return toPublicUser(user);
  }

  async updateProfile(id: string, dto: UpdateProfileDto): Promise<PublicUser> {
    if (dto.fullName === undefined && dto.phoneNumber === undefined) {
      return this.getProfile(id);
    }

    const update: Record<string, unknown> = {};
    if (dto.fullName !== undefined) {
      update.fullName = dto.fullName;
    }
    if (dto.phoneNumber !== undefined) {
      update.phoneNumber = dto.phoneNumber;
    }

    const user = (await UserModel.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true },
    )
      .select(USER_PUBLIC_FIELDS)
      .lean()) as unknown as UserDoc | null;

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return toPublicUser(user);
  }
}
