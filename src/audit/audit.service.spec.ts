import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { AuditService } from './audit.service';

describe('AuditService', () => {
  it('emits a structured audit log', () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);

    const service = new AuditService();
    service.record({
      action: 'DELIVERY_ASSIGNED',
      actorId: 'admin-1',
      targetType: 'DELIVERY',
      targetId: 'delivery-1',
      metadata: { riderId: 'rider-1' },
    });

    expect(log).toHaveBeenCalledTimes(1);
    const message = String(log.mock.calls[0][0]);
    expect(JSON.parse(message)).toMatchObject({
      event: 'audit',
      action: 'DELIVERY_ASSIGNED',
      actorId: 'admin-1',
      targetType: 'DELIVERY',
      targetId: 'delivery-1',
      metadata: { riderId: 'rider-1' },
      timestamp: expect.any(String),
    });

    log.mockRestore();
  });
});
