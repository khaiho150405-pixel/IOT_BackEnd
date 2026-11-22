import { Inject, Injectable } from '@nestjs/common';
import { AuthService, AuthUser } from '../auth/auth.service';
import { AiotGateway } from './aiot.gateway';

/** Devices a user may see: registry (names, rooms) merged with live gateway state and the user's rights. */
@Injectable()
export class DevicesService {
  constructor(@Inject(AiotGateway) private gateway: AiotGateway, @Inject(AuthService) private auth: AuthService) {}

  async visibleDevices(user: AuthUser) {
    const [access, known] = await Promise.all([this.auth.deviceAccess(user), this.auth.listDevices()]);
    const live = new Map(this.gateway.dashboardDevices().map(d => [d.id, d]));
    return known.filter(d => access.has(d.id)).map(d => ({
      ...(live.get(d.id) ?? { id: d.id, connected: false, busy: false, ledEnabled: undefined, sensor: null }),
      name: d.name, roomId: d.roomId, lastSeenAt: d.lastSeenAt,
      canControl: access.get(d.id)!.control, canChat: access.get(d.id)!.chat,
    }));
  }
}
