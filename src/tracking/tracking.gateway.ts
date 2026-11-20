import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { isObjectIdString } from '../common/object-id';
import { DeliveryStatus, UserRole } from '../database/enums';
import { DeliveryModel, UserModel } from '../database/models';
import type { DeliveryDoc, UserDoc } from '../database/views';
import { Public } from '../auth/decorators/public.decorator';
import {
  AccessJwtPayload,
  AuthenticatedUser,
} from '../auth/types/authenticated-user';
import { DeliveryView } from '../deliveries/deliveries.select';
import type { TrackingLocation } from './tracking.service';

@Public()
@WebSocketGateway({
  namespace: '/tracking',
  cors: { origin: true, credentials: true },
  transports: ['websocket'],
})
export class TrackingGateway {
  @WebSocketServer()
  private server!: Server;

  private readonly accessSecret: string;

  constructor(
    config: ConfigService,
    private readonly jwtService: JwtService,
  ) {
    this.accessSecret = config.getOrThrow<string>('JWT_ACCESS_SECRET');
  }

  afterInit(server: Server): void {
    server.use((socket, next) => {
      this.authenticate(socket)
        .then(() => next())
        .catch(() => next(new Error('Unauthorized')));
    });
  }

  @SubscribeMessage('delivery:join')
  async joinDelivery(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ joined: true; deliveryId: string }> {
    const user = this.getUser(client);
    const deliveryId = this.getDeliveryId(body);
    const delivery = (await DeliveryModel.findById(deliveryId)
      .populate('order', 'customerId')
      .lean()) as unknown as DeliveryDoc | null;

    if (
      !delivery ||
      !this.canView(user, delivery.riderId, delivery.order?.customerId ?? '')
    ) {
      throw new WsException('Delivery not found');
    }

    await client.join(this.room(deliveryId));

    return { joined: true, deliveryId };
  }

  @SubscribeMessage('delivery:leave')
  async leaveDelivery(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ left: true; deliveryId: string }> {
    const deliveryId = this.getDeliveryId(body);
    await client.leave(this.room(deliveryId));

    return { left: true, deliveryId };
  }

  emitDeliveryAssigned(delivery: DeliveryView): void {
    this.emit(delivery.id, 'delivery:assigned', {
      deliveryId: delivery.id,
      orderId: delivery.orderId,
      orderNumber: delivery.order.orderNumber,
      riderId: delivery.riderId,
      status: delivery.status,
    });
  }

  emitStatusUpdated(delivery: DeliveryView): void {
    const event =
      delivery.status === DeliveryStatus.DELIVERED
        ? 'delivery:completed'
        : delivery.status === DeliveryStatus.FAILED
          ? 'delivery:failed'
          : 'delivery:status_updated';

    this.emit(delivery.id, event, {
      deliveryId: delivery.id,
      status: delivery.status,
      failureReason: delivery.failureReason,
      updatedAt: delivery.updatedAt,
    });
  }

  emitLocationUpdated(
    deliveryId: string,
    status: DeliveryStatus,
    location: TrackingLocation,
  ): void {
    this.emit(deliveryId, 'delivery:location_updated', {
      deliveryId,
      status,
      location,
    });
  }

  private async authenticate(socket: Socket): Promise<void> {
    const token = this.extractToken(socket);

    if (!token) {
      throw new Error('Missing access token');
    }

    const payload = await this.jwtService.verifyAsync<AccessJwtPayload>(token, {
      secret: this.accessSecret,
    });

    if (payload.type !== 'access' || !payload.sub) {
      throw new Error('Invalid access token');
    }

    const user = (await UserModel.findOne({ _id: payload.sub })
      .select('_id email role isActive')
      .lean()) as unknown as UserDoc | null;

    if (!user?.isActive) {
      throw new Error('Invalid access token');
    }

    socket.data.user = {
      id: user._id,
      email: user.email,
      role: user.role,
    } satisfies AuthenticatedUser;
  }

  private extractToken(socket: Socket): string | undefined {
    const authToken = socket.handshake.auth?.token;
    if (typeof authToken === 'string' && authToken.length > 0) {
      return authToken;
    }

    const authorization = socket.handshake.headers.authorization;
    if (
      typeof authorization === 'string' &&
      authorization.startsWith('Bearer ')
    ) {
      return authorization.slice('Bearer '.length);
    }

    return undefined;
  }

  private getUser(client: Socket): AuthenticatedUser {
    const user = client.data.user as AuthenticatedUser | undefined;

    if (!user) {
      throw new WsException('Unauthorized');
    }

    return user;
  }

  private getDeliveryId(body: unknown): string {
    if (
      typeof body !== 'object' ||
      body === null ||
      typeof (body as { deliveryId?: unknown }).deliveryId !== 'string'
    ) {
      throw new WsException('Invalid delivery id');
    }

    const deliveryId = (body as { deliveryId: string }).deliveryId;

    if (!isObjectIdString(deliveryId)) {
      throw new WsException('Invalid delivery id');
    }

    return deliveryId;
  }

  private canView(
    user: AuthenticatedUser,
    riderId: string | null,
    customerId: string,
  ): boolean {
    return (
      user.role === UserRole.ADMIN ||
      (Boolean(riderId) && riderId === user.id) ||
      customerId === user.id
    );
  }

  private emit(
    deliveryId: string,
    event: string,
    payload: Record<string, unknown>,
  ): void {
    this.server.to(this.room(deliveryId)).emit(event, payload);
  }

  private room(deliveryId: string): string {
    return `delivery:${deliveryId}`;
  }
}
