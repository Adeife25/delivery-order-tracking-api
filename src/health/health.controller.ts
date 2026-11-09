import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

type DependencyStatus = 'up' | 'down' | 'disabled';

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Check whether the API process is running' })
  @ApiOkResponse({ description: 'The API process is running' })
  getHealth(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Check whether the API can reach its dependencies',
  })
  @ApiOkResponse({ description: 'The API is ready to serve traffic' })
  async getReadiness(): Promise<{
    status: 'ok';
    database: 'up';
    redis: DependencyStatus;
  }> {
    const databaseUp = await this.isDatabaseUp();
    const redisStatus: DependencyStatus = this.redis.isEnabled()
      ? (await this.redis.ping())
        ? 'up'
        : 'down'
      : 'disabled';

    if (!databaseUp || redisStatus === 'down') {
      throw new ServiceUnavailableException({
        status: 'error',
        database: databaseUp ? 'up' : 'down',
        redis: redisStatus,
      });
    }

    return { status: 'ok', database: 'up', redis: redisStatus };
  }

  private async isDatabaseUp(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
