import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createServer, Server as NetServer } from 'node:net';
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
      this.broker = new Aedes();
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

  private async connectClient(url: string): Promise<void> {
    try {
      const opts: mqtt.IClientOptions = {
        clientId: `aiot_backend_${Math.random().toString(16).slice(2, 8)}`,
        clean: true,
        connectTimeout: 5000,
        reconnectPeriod: 5000,
      };
      if (process.env.MQTT_USERNAME) opts.username = process.env.MQTT_USERNAME;
      if (process.env.MQTT_PASSWORD) opts.password = process.env.MQTT_PASSWORD;

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
