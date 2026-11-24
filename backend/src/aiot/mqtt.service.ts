import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Action, AuthService, AuthUser } from '../auth/auth.service';
import { createServer, Server as NetServer } from 'node:net';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { clientIp } from '../auth/auth.guard';
import { routeUpgrade } from '../network/upgrade';
import { Aedes } from 'aedes';
import * as mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';
import type { Sensor, DecisionValue } from './aiot.service';

export interface MqttCommandPayload {
  action?: 'led' | 'text' | 'say' | 'music' | 'status';
  state?: 'on' | 'off' | 'toggle';
  text?: string;
  command?: 'play' | 'stop';
  trackId?: string;
}

export interface GatewayBridge {
  dashboardDevices(): Array<{
    id: string;
    connected: boolean;
    ledEnabled?: boolean;
    busy?: boolean;
    sensor?: { temperature: number; humidity: number; receivedAt: string; stale: boolean } | null;
  }>;
  getFirstOnlineDeviceId?(): string | undefined;
  setDashboardLed(deviceId: string, enabled: boolean): Promise<any>;
  submitDashboardText(deviceId: string, text: string): Promise<{
    transcript: string;
    reply: string;
    language: string;
    intent: DecisionValue['intent'];
  }>;
}

@Injectable()
export class AiotMqttService implements OnModuleInit, OnModuleDestroy {
  private broker?: any;
  private netServer?: NetServer;
  private client?: MqttClient;
  private gateway?: GatewayBridge;
  private embedded = false;
  private brokerPort = Number(process.env.MQTT_PORT || 1883);
  // The backend's own client signs in to the embedded broker with a per-process secret.
  private readonly internalUser = '__aiot_backend__';
  private readonly internalPassword = randomBytes(24).toString('base64url');
  private wsServer?: WebSocketServer;
  private wsClients = 0;
  // Home Assistant MQTT Discovery (HA_DISCOVERY=false turns it off).
  private readonly discoveryPrefix = (process.env.HA_DISCOVERY_PREFIX || 'homeassistant').replace(/[^a-zA-Z0-9_-]/g, '');
  private readonly discoveryEnabled = process.env.HA_DISCOVERY !== 'false';
  private discovered = new Set<string>();

  constructor(@Optional() @Inject(AuthService) private auth?: AuthService) {}

  setGateway(gateway: GatewayBridge) {
    this.gateway = gateway;
  }

  async onModuleInit() {
    if (process.env.MQTT_ENABLED === 'false') {
      console.log('MQTT is disabled via MQTT_ENABLED=false');
      return;
    }

    const brokerUrl = process.env.MQTT_BROKER_URL?.trim();
    if (!brokerUrl || process.env.MQTT_EMBEDDED_BROKER === 'true') {
      await this.startEmbeddedBroker();
    }

    await this.connectClient(brokerUrl || `mqtt://127.0.0.1:${this.brokerPort}`);
  }

  private async startEmbeddedBroker(): Promise<void> {
    try {
      this.broker = new Aedes(this.auth ? {
        authenticate: this.authenticate.bind(this),
        authorizePublish: this.authorizePublish.bind(this),
        authorizeSubscribe: this.authorizeSubscribe.bind(this),
      } : {});
      await this.broker.listen();
      this.netServer = createServer(this.broker.handle.bind(this.broker));

      await new Promise<void>((resolve, reject) => {
        this.netServer!.once('error', reject);
        this.netServer!.listen(this.brokerPort, '0.0.0.0', () => {
          this.embedded = true;
          console.log(`[MQTT] Embedded MQTT Broker listening on 0.0.0.0:${this.brokerPort} (TCP)`);
          resolve();
        });
      });

      this.broker.on('client', (client: any) => {
        console.log(`[MQTT] Client connected to embedded broker: ${client.id}`);
      });
      this.broker.on('clientDisconnect', (client: any) => {
        console.log(`[MQTT] Client disconnected: ${client.id}`);
      });
      this.broker.on('subscribe', (subscriptions: any[], client: any) => {
        for (const sub of subscriptions) {
          console.log(`[MQTT] ${client.id} subscribed to ${sub.topic}`);
        }
      });
    } catch (error) {
      console.warn(`[MQTT] Could not start embedded broker on port ${this.brokerPort}: ${(error as Error).message}. Will try external broker if configured.`);
    }
  }

  /**
   * MQTT over WebSocket at /mqtt on the backend's HTTP/HTTPS servers, so MQTT apps and Home
   * Assistant can connect from the Internet through the HTTPS tunnel
   * (wss://<domain>/mqtt). Same embedded broker, same account sign-in and permissions as
   * TCP 1883; at most MQTT_WS_MAX_CLIENTS (default 50) connections.
   */
  attachWebSocket(server: HttpServer) {
    if (!this.broker || process.env.MQTT_WS_ENABLED === 'false') return;
    if (!this.wsServer) {
      const max = Number(process.env.MQTT_WS_MAX_CLIENTS || 50);
      this.wsServer = new WebSocketServer({
        noServer: true, maxPayload: 256 * 1024,
        // MQTT clients ask for the "mqtt" (or legacy "mqttv3.1") subprotocol.
        handleProtocols: protocols => protocols.has('mqtt') ? 'mqtt' : protocols.has('mqttv3.1') ? 'mqttv3.1' : false,
      });
      this.wsServer.on('connection', (ws, req: IncomingMessage) => {
        if (this.wsClients >= max) { ws.close(1013, 'busy'); return; }
        this.wsClients++;
        ws.once('close', () => { this.wsClients--; });
        const stream = createWebSocketStream(ws);
        stream.on('error', () => ws.terminate());
        this.broker.handle(stream, req);
      });
    }
    routeUpgrade(server, '/mqtt', this.wsServer);
  }

  private async connectClient(url: string): Promise<void> {
    try {
      const opts: mqtt.IClientOptions = {
        clientId: `aiot_backend_${Math.random().toString(16).slice(2, 8)}`,
        clean: true,
        connectTimeout: 5000,
        reconnectPeriod: 5000,
      };
      if (this.embedded && this.auth) {
        opts.username = this.internalUser;
        opts.password = this.internalPassword;
      } else {
        if (process.env.MQTT_USERNAME) opts.username = process.env.MQTT_USERNAME;
        if (process.env.MQTT_PASSWORD) opts.password = process.env.MQTT_PASSWORD;
      }

      this.client = mqtt.connect(url, opts);

      this.client.on('connect', () => {
        console.log(`[MQTT] Backend client connected to broker at ${url}`);
        this.subscribeTopics();
        this.publishSystemStatus('online');
      });

      this.client.on('message', (topic, payload) => {
        this.handleIncomingMessage(topic, payload.toString('utf8'));
      });

      this.client.on('error', err => {
        console.warn(`[MQTT] Client error: ${err.message}`);
      });
    } catch (error) {
      console.warn(`[MQTT] Failed to initialize MQTT client: ${(error as Error).message}`);
    }
  }

  private subscribeTopics() {
    if (!this.client) return;
    const topics = [
      'aiot/command',
      'aiot/device/+/command',
      'aiot/led/set',
      'aiot/device/+/led/set',
      // Home Assistant announces itself here after a restart: re-send the discovery configs.
      ...(this.discoveryEnabled ? [`${this.discoveryPrefix}/status`] : []),
    ];
    for (const t of topics) {
      this.client.subscribe(t, { qos: 1 }, err => {
        if (!err) console.log(`[MQTT] Subscribed to topic: ${t}`);
      });
    }
  }

  publishSensor(deviceId: string, sensor?: Sensor) {
    if (!this.client || !this.client.connected || !sensor) return;
    const payload = JSON.stringify({
      deviceId,
      temperature: sensor.temperature,
      humidity: sensor.humidity,
      valid: true,
      timestamp: new Date(sensor.receivedAt).toISOString(),
    });
    this.client.publish(`aiot/device/${deviceId}/sensor`, payload, { qos: 0, retain: true });
    this.client.publish('aiot/sensor', payload, { qos: 0, retain: true });
  }

  publishState(deviceId: string, state: { connected: boolean; ledEnabled?: boolean; busy?: boolean }) {
    if (!this.client || !this.client.connected) return;
    if (state.connected && !this.discovered.has(deviceId)) this.publishDiscovery(deviceId);
    const payload = JSON.stringify({
      deviceId,
      connected: state.connected,
      ledEnabled: state.ledEnabled,
      busy: state.busy,
      timestamp: new Date().toISOString(),
    });
    this.client.publish(`aiot/device/${deviceId}/state`, payload, { qos: 1, retain: true });
    this.client.publish('aiot/state', payload, { qos: 1, retain: true });
    // Also publish simple state for Home Assistant / IoT MQTT Panel widgets
    if (state.ledEnabled !== undefined) {
      this.client.publish(`aiot/device/${deviceId}/led/status`, state.ledEnabled ? 'ON' : 'OFF', { qos: 1, retain: true });
      this.client.publish('aiot/led/status', state.ledEnabled ? 'ON' : 'OFF', { qos: 1, retain: true });
    }
  }

  /** Active alerts of one device (retained): {active, alerts: [{kind, value, threshold, since, message}]}. */
  publishAlert(deviceId: string, alerts: Array<{ kind: string; value: number; threshold: number; since: string; message: string }>) {
    if (!this.client || !this.client.connected) return;
    const payload = JSON.stringify({
      deviceId, active: alerts.length > 0, alerts,
      message: alerts.map(a => a.message).join('; ') || 'Bình thường',
      timestamp: new Date().toISOString(),
    });
    this.client.publish(`aiot/device/${deviceId}/alert`, payload, { qos: 1, retain: true });
    this.client.publish('aiot/alert', payload, { qos: 1, retain: true });
  }

  publishChat(deviceId: string, turn: DecisionValue) {
    if (!this.client || !this.client.connected) return;
    const payload = JSON.stringify({
      deviceId,
      transcript: turn.transcript,
      reply: turn.reply,
      intent: turn.intent,
      language: turn.language,
      timestamp: new Date().toISOString(),
    });
    this.client.publish(`aiot/device/${deviceId}/chat`, payload, { qos: 1 });
    this.client.publish('aiot/chat', payload, { qos: 1 });
  }

  publishResponse(deviceId: string, response: Record<string, any>) {
    if (!this.client || !this.client.connected) return;
    const payload = JSON.stringify({
      deviceId,
      ...response,
      timestamp: new Date().toISOString(),
    });
    this.client.publish(`aiot/device/${deviceId}/response`, payload, { qos: 1 });
    this.client.publish('aiot/response', payload, { qos: 1 });
  }

  /**
   * Home Assistant MQTT Discovery: one HA device per ESP32 with a light (LED), temperature and
   * humidity sensors, connectivity and "busy" binary sensors, the last AI reply, and a text box
   * to ask the assistant. Retained configs under <prefix>/<component>/<node>/<object>/config;
   * every entity uses the existing aiot/device/<id>/... topics, so nothing else changes.
   */
  publishDiscovery(deviceId: string) {
    if (!this.discoveryEnabled || !this.client || !this.client.connected) return;
    this.discovered.add(deviceId);
    const node = 'aiot_' + deviceId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    const base = `aiot/device/${deviceId}`;
    const device = {
      identifiers: [node], name: `AIoT Smart Room ${deviceId.slice(-5)}`,
      manufacturer: 'AIoT Smart Room', model: 'ESP32-S3 N16R8 voice assistant',
      connections: /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(deviceId) ? [['mac', deviceId.toLowerCase()]] : undefined,
    };
    const availability = {
      availability_topic: `${base}/state`,
      availability_template: "{{ 'online' if value_json.connected else 'offline' }}",
    };
    const entities: Array<[string, string, Record<string, unknown>]> = [
      ['light', 'led', { name: 'Đèn', command_topic: `${base}/led/set`, state_topic: `${base}/led/status`,
        payload_on: 'ON', payload_off: 'OFF', ...availability }],
      ['sensor', 'temperature', { name: 'Nhiệt độ', state_topic: `${base}/sensor`, device_class: 'temperature',
        unit_of_measurement: '°C', state_class: 'measurement', value_template: '{{ value_json.temperature | round(1) }}', ...availability }],
      ['sensor', 'humidity', { name: 'Độ ẩm', state_topic: `${base}/sensor`, device_class: 'humidity',
        unit_of_measurement: '%', state_class: 'measurement', value_template: '{{ value_json.humidity | round(1) }}', ...availability }],
      ['binary_sensor', 'online', { name: 'Kết nối', state_topic: `${base}/state`, device_class: 'connectivity',
        value_template: "{{ 'ON' if value_json.connected else 'OFF' }}" }],
      ['binary_sensor', 'busy', { name: 'Đang xử lý', state_topic: `${base}/state`, icon: 'mdi:robot',
        value_template: "{{ 'ON' if value_json.busy else 'OFF' }}", ...availability }],
      ['binary_sensor', 'alert', { name: 'Cảnh báo', state_topic: `${base}/alert`, device_class: 'problem',
        value_template: "{{ 'ON' if value_json.active else 'OFF' }}", json_attributes_topic: `${base}/alert` }],
      ['sensor', 'reply', { name: 'Trả lời gần nhất', state_topic: `${base}/chat`, icon: 'mdi:message-reply-text',
        value_template: '{{ value_json.reply[:250] }}' }],
      ['text', 'ask', { name: 'Hỏi trợ lý', command_topic: `${base}/command`, icon: 'mdi:chat-question', max: 200,
        command_template: '{"action": "text", "text": {{ value | tojson }}}', ...availability }],
    ];
    for (const [component, object, config] of entities) {
      const payload = JSON.stringify({ ...config, unique_id: `${node}_${object}`, device });
      this.client.publish(`${this.discoveryPrefix}/${component}/${node}/${object}/config`, payload, { qos: 1, retain: true });
    }
  }

  private publishSystemStatus(status: 'online' | 'offline') {
    if (!this.client || !this.client.connected) return;
    const payload = JSON.stringify({
      system: 'AIoT-Controller',
      status,
      timestamp: new Date().toISOString(),
      broker: this.embedded ? 'embedded' : 'external',
    });
    this.client.publish('aiot/system/status', payload, { qos: 1, retain: true });
  }

  // ---------------------------------------------------------------- embedded broker security
  // Every MQTT client signs in with a user account (same username/password as the web).
  // Commands are checked against that account's device permissions on every publish.

  private authenticate(client: any, username: string | undefined, password: Buffer | undefined,
    done: (error: any, success: boolean | null) => void) {
    if (username === this.internalUser) {
      const ok = !!password && password.toString() === this.internalPassword;
      if (ok) client.aiotInternal = true;
      return done(ok ? null : Object.assign(new Error('Bad credentials'), { returnCode: 4 }), ok);
    }
    if (!username || !password) return done(Object.assign(new Error('Login required'), { returnCode: 4 }), false);
    // TCP: the socket address. WebSocket (/mqtt): the visitor address the tunnel reports.
    const ip = client?.req ? clientIp(client.req) : String(client?.conn?.remoteAddress || '').replace(/^::ffff:/, '');
    this.auth!.checkCredentials(username, password.toString(), ip).then(user => {
      client.aiotUser = this.auth!.toAuthUser(user);
      void this.auth!.audit({ user: client.aiotUser, source: 'mqtt', action: 'auth:login', ip });
      done(null, true);
    }, error => {
      void this.auth!.audit({ username: String(username).slice(0, 64), source: 'mqtt', action: 'auth:login', result: 'denied', ip });
      done(Object.assign(new Error((error as Error).message), { returnCode: 4 }), false);
    });
  }

  /** Which permission a command needs: chatting with the AI needs device:chat, status needs view. */
  private requiredAction(topic: string, payload: string): Action | undefined {
    if (topic === 'aiot/led/set' || /^aiot\/device\/[^/]+\/led\/set$/.test(topic)) return 'device:control';
    if (topic === 'aiot/command' || /^aiot\/device\/[^/]+\/command$/.test(topic)) {
      let action: string | undefined;
      try { action = JSON.parse(payload)?.action; } catch { /* plain text: treat as control */ }
      if (action === 'text' || action === 'say') return 'device:chat';
      if (action === 'status') return 'device:view';
      return 'device:control';
    }
    return undefined; // telemetry topics are published by the backend only
  }

  private authorizePublish(client: any, packet: any, callback: (error?: Error | null) => void) {
    if (!client || client.aiotInternal) return callback(null);
    const user: AuthUser | undefined = client.aiotUser;
    const topic = String(packet.topic || '');
    // Home Assistant's birth/last-will message (signed-in account only); it only triggers a
    // re-send of the discovery configs.
    if (user && this.discoveryEnabled && topic === `${this.discoveryPrefix}/status`) return callback(null);
    const payload = Buffer.isBuffer(packet.payload) ? packet.payload.toString('utf8') : String(packet.payload ?? '');
    const action = this.requiredAction(topic, payload);
    const deviceId = action ? this.resolveDeviceId(topic) : undefined;
    // Refusing with an error makes aedes disconnect the client, so one wrong tap in a phone
    // MQTT app would drop the session. Instead the packet is diverted to a "$" topic that no
    // subscription (not even "#") matches, and is never retained: it is dropped, and audited.
    const deny = (reason: string) => {
      void this.auth!.audit({ user, source: 'mqtt', action: action ?? 'mqtt:publish', deviceId, result: 'denied', detail: `${topic}: ${reason}` });
      packet.topic = '$aiot/denied';
      packet.retain = false;
      callback(null);
    };
    if (!user || !action) return deny('chỉ backend được gửi lên topic này');
    if (!deviceId) return deny('không có thiết bị');
    this.auth!.can(user, action, deviceId).then(ok => {
      if (!ok) return deny('không có quyền');
      void this.auth!.audit({ user, source: 'mqtt', action, deviceId, detail: `${topic}: ${payload.slice(0, 200)}` });
      callback(null);
    }, () => deny('lỗi kiểm tra quyền'));
  }

  /** Single account type: any signed-in account may follow every topic; anonymous clients never get here. */
  private authorizeSubscribe(client: any, subscription: any, callback: (error: Error | null, subscription?: any) => void) {
    if (client?.aiotInternal || client?.aiotUser) return callback(null, subscription);
    callback(null, null);
  }

  private resolveDeviceId(topic: string): string | undefined {
    // If topic is aiot/device/<id>/command
    const match = /^aiot\/device\/([^/]+)\//.exec(topic);
    if (match && match[1]) return match[1];

    // Fallback: active online device from gateway
    if (this.gateway) {
      if (typeof this.gateway.getFirstOnlineDeviceId === 'function') {
        const id = this.gateway.getFirstOnlineDeviceId();
        if (id) return id;
      }
      const devices = this.gateway.dashboardDevices();
      const online = devices.find(d => d.connected);
      return online?.id || devices[0]?.id;
    }
    return undefined;
  }

  private async handleIncomingMessage(topic: string, raw: string) {
    if (this.discoveryEnabled && topic === `${this.discoveryPrefix}/status`) {
      if (raw.trim() === 'online') for (const device of this.gateway?.dashboardDevices() ?? []) this.publishDiscovery(device.id);
      return;
    }
    console.log(`[MQTT] Incoming on ${topic}: ${raw.slice(0, 150)}`);
    const deviceId = this.resolveDeviceId(topic);
    if (!deviceId) {
      console.warn(`[MQTT] Received command on ${topic} but no ESP32 device is available.`);
      if (this.client?.connected) {
        this.client.publish('aiot/response', JSON.stringify({
          status: 'error',
          error: 'NO_DEVICE_CONNECTED',
          message: 'Chưa có ESP32 nào kết nối tới backend.',
        }));
      }
      return;
    }

    let parsed: MqttCommandPayload = {};
    const trimmed = raw.trim();

    // Check if it's a simple text command
    if (topic.endsWith('/led/set') || topic === 'aiot/led/set') {
      const lower = trimmed.toLowerCase();
      parsed = { action: 'led', state: (lower === 'on' || lower === '1' || lower === 'true' || lower === 'bat') ? 'on' : 'off' };
    } else if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = { action: 'text', text: trimmed };
      }
    } else {
      const lower = trimmed.toLowerCase();
      if (['on', 'bat', 'bật', 'bat_den', 'bật đèn'].includes(lower)) parsed = { action: 'led', state: 'on' };
      else if (['off', 'tat', 'tắt', 'tat_den', 'tắt đèn'].includes(lower)) parsed = { action: 'led', state: 'off' };
      else if (['toggle', 'dao_chieu'].includes(lower)) parsed = { action: 'led', state: 'toggle' };
      else parsed = { action: 'text', text: trimmed };
    }

    try {
      if (parsed.action === 'led') {
        let targetState: boolean;
        if (parsed.state === 'toggle') {
          const current = this.gateway?.dashboardDevices().find(d => d.id === deviceId);
          targetState = !(current?.ledEnabled ?? false);
        } else {
          targetState = parsed.state === 'on';
        }
        await this.gateway?.setDashboardLed(deviceId, targetState);
        this.publishResponse(deviceId, {
          status: 'ok',
          action: 'led',
          ledEnabled: targetState,
          message: `Đã ${targetState ? 'bật' : 'tắt'} đèn thành công.`,
        });
      } else if (parsed.action === 'text' || parsed.action === 'say') {
        const text = parsed.text || trimmed;
        if (text) {
          const result = await this.gateway?.submitDashboardText(deviceId, text);
          this.publishResponse(deviceId, {
            status: 'ok',
            action: 'text',
            transcript: result?.transcript,
            reply: result?.reply,
            intent: result?.intent,
          });
        }
      } else if (parsed.action === 'status') {
        const device = this.gateway?.dashboardDevices().find(d => d.id === deviceId);
        if (device) {
          this.publishState(deviceId, { connected: device.connected, ledEnabled: device.ledEnabled, busy: device.busy });
          if (device.sensor) {
            this.publishSensor(deviceId, {
              temperature: device.sensor.temperature,
              humidity: device.sensor.humidity,
              receivedAt: new Date(device.sensor.receivedAt).getTime(),
            });
          }
        }
      }
    } catch (error) {
      console.warn(`[MQTT] Error executing command: ${(error as Error).message}`);
      this.publishResponse(deviceId, {
        status: 'error',
        error: (error as Error).message,
      });
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      this.publishSystemStatus('offline');
      this.client.end(true);
    }
    if (this.broker) {
      await new Promise<void>(resolve => {
        this.broker.close(() => {
          if (this.netServer) this.netServer.close(() => resolve());
          else resolve();
        });
      });
    }
  }
}
