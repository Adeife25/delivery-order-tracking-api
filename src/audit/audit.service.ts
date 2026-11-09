import { Injectable, Logger } from '@nestjs/common';

export interface AuditEvent {
  action: string;
  actorId: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  record(event: AuditEvent): void {
    this.logger.log(
      JSON.stringify({
        event: 'audit',
        timestamp: new Date().toISOString(),
        ...event,
      }),
    );
  }
}
