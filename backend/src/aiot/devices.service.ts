import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
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

  /**
   * Read-only view for visitors who are not signed in: device name, online state, temperature,
   * humidity and LED state. No MAC address (an opaque key instead), no room, no controls.
   */
  async publicDevices() {
    const known = await this.auth.listDevices();
    const live = new Map(this.gateway.dashboardDevices().map(d => [d.id, d]));
    return known.map(d => {
      const state = live.get(d.id);
      return {
        id: createHash('sha256').update(d.id).digest('hex').slice(0, 12),
        name: d.name,
        connected: !!state?.connected,
        ledEnabled: state?.ledEnabled,
        sensor: state?.sensor ?? null,
        canControl: false, canChat: false,
      };
    });
  }
}
