import {
  ArgumentMetadata,
  BadRequestException,
  PipeTransform,
} from '@nestjs/common';
import { registerDecorator, type ValidationOptions } from 'class-validator';

export function isObjectIdString(value: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(value);
}

export class ParseObjectIdPipe implements PipeTransform<string, string> {
  transform(value: string, metadata: ArgumentMetadata): string {
    if (typeof value !== 'string' || !isObjectIdString(value)) {
      throw new BadRequestException(
        `${metadata.data ?? 'id'} must be a 24-character hexadecimal id`,
      );
    }

    return value;
  }
}

export function IsObjectIdString(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: 'isObjectIdString',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && isObjectIdString(value);
        },
        defaultMessage(): string {
          return 'must be a 24-character hexadecimal id';
        },
      },
    });
  };
}
