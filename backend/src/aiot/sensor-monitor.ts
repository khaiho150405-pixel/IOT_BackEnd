import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource, LessThan, MoreThanOrEqual } from 'typeorm';
import { AuthService } from '../auth/auth.service';
import type { SensorReading } from '../auth/entities';

export interface AlertSettings {
  enabled: boolean;
  temperatureHigh: number;
  temperatureLow: number;
  humidityHigh: number;
  humidityLow: number;
  /** A value must stay outside its limit this long before an alert is raised (no alerts on one odd reading). */
  holdSeconds: number;
}
export type AlertKind = 'temperature_high' | 'temperature_low' | 'humidity_high' | 'humidity_low';
export interface ActiveAlert { kind: AlertKind; value: number; threshold: number; since: string; message: string }
export interface HistoryPoint {
  at: string;
  temperature: number; humidity: number;
  temperatureMin: number; temperatureMax: number;
  humidityMin: number; humidityMax: number;
  samples: number;
}
export type AlertListener = (deviceId: string, alert: ActiveAlert, raised: boolean) => void;

export const HISTORY_RANGES = {
  '1h': { ms: 3_600_000, bucketMinutes: 1 },
  '24h': { ms: 86_400_000, bucketMinutes: 5 },
  '7d': { ms: 7 * 86_400_000, bucketMinutes: 30 },
  '30d': { ms: 30 * 86_400_000, bucketMinutes: 120 },
} as const;
export type HistoryRange = keyof typeof HISTORY_RANGES;

interface Bucket {
  minute: number; n: number; tSum: number; hSum: number;
  tMin: number; tMax: number; hMin: number; hMax: number;
}
interface KindState { pendingSince?: number; active?: ActiveAlert }

const KINDS: AlertKind[] = ['temperature_high', 'temperature_low', 'humidity_high', 'humidity_low'];
/** Hysteresis: an alert clears only once the value is back inside by this margin. */
const MARGIN = { temperature: 0.5, humidity: 2 };
const LABEL: Record<AlertKind, string> = {
  temperature_high: 'Nhiệt độ cao', temperature_low: 'Nhiệt độ thấp',
  humidity_high: 'Độ ẩm cao', humidity_low: 'Độ ẩm thấp',
};

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return process.env[name] && Number.isFinite(value) ? value : fallback;
}
export function defaultAlertSettings(): AlertSettings {
  return {
    enabled: process.env.ALERTS_ENABLED !== 'false',
    temperatureHigh: envNumber('ALERT_TEMP_HIGH', 33),
    temperatureLow: envNumber('ALERT_TEMP_LOW', 16),
    humidityHigh: envNumber('ALERT_HUMIDITY_HIGH', 85),
    humidityLow: envNumber('ALERT_HUMIDITY_LOW', 30),
    holdSeconds: envNumber('ALERT_HOLD_S', 60),
  };
}

/** Checks a settings update; returns the merged settings or throws an Error with a Vietnamese message. */
export function validateAlertSettings(current: AlertSettings, input: any): AlertSettings {
  if (!input || typeof input !== 'object') throw new Error('Thiếu dữ liệu cài đặt.');
  const next = { ...current };
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new Error('enabled phải là true hoặc false.');
    next.enabled = input.enabled;
  }
  const limits: Array<[keyof AlertSettings, number, number, string]> = [
    ['temperatureHigh', -20, 80, 'Ngưỡng nhiệt độ cao'], ['temperatureLow', -40, 60, 'Ngưỡng nhiệt độ thấp'],
    ['humidityHigh', 1, 100, 'Ngưỡng độ ẩm cao'], ['humidityLow', 0, 99, 'Ngưỡng độ ẩm thấp'],
    ['holdSeconds', 0, 3600, 'Thời gian giữ'],
  ];
  for (const [key, min, max, label] of limits) {
    if (input[key] === undefined) continue;
    const value = Number(input[key]);
    if (typeof input[key] === 'boolean' || input[key] === '' || !Number.isFinite(value) || value < min || value > max)
      throw new Error(`${label} phải là số từ ${min} đến ${max}.`);
    (next as any)[key] = Math.round(value * 10) / 10;
  }
  if (next.temperatureLow >= next.temperatureHigh) throw new Error('Ngưỡng nhiệt độ thấp phải nhỏ hơn ngưỡng cao.');
  if (next.humidityLow >= next.humidityHigh) throw new Error('Ngưỡng độ ẩm thấp phải nhỏ hơn ngưỡng cao.');
  return next;
}

/** Merges per-minute rows into buckets of bucketMinutes (weighted averages, overall min/max). */
export function downsample(rows: HistoryPoint[], bucketMinutes: number): HistoryPoint[] {
  const size = bucketMinutes * 60_000;
  const groups = new Map<number, HistoryPoint[]>();
  for (const row of rows) {
    const key = Math.floor(Date.parse(row.at) / size) * size;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(row);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([key, group]) => {
    const samples = group.reduce((sum, r) => sum + r.samples, 0) || group.length;
    const weight = (r: HistoryPoint) => (r.samples || 1);
    const avg = (field: 'temperature' | 'humidity') =>
      Math.round(group.reduce((sum, r) => sum + r[field] * weight(r), 0) / group.reduce((sum, r) => sum + weight(r), 0) * 100) / 100;
    return {
      at: new Date(key).toISOString(),
      temperature: avg('temperature'), humidity: avg('humidity'),
      temperatureMin: Math.min(...group.map(r => r.temperatureMin)), temperatureMax: Math.max(...group.map(r => r.temperatureMax)),
      humidityMin: Math.min(...group.map(r => r.humidityMin)), humidityMax: Math.max(...group.map(r => r.humidityMax)),
      samples,
    };
  });
}

/**
 * Sensor history and alerts. Every report (every 2 s) is folded into a one-minute bucket per
 * device; each finished minute becomes one row in aiot_sensor_readings (same database as the
 * accounts), kept SENSOR_HISTORY_DAYS days (30). Alerts: when temperature or humidity stays
 * outside its limit for holdSeconds, an alert is raised (audit log, MQTT, dashboard, OLED via
 * listeners) and cleared once the value is back inside by a small margin.
 */
@Injectable()
export class SensorMonitor implements OnModuleInit, OnModuleDestroy {
  private db?: DataSource;
  private settingsFile?: string;
  private settings = defaultAlertSettings();
  private buckets = new Map<string, Bucket>();
  private alertState = new Map<string, Map<AlertKind, KindState>>();
  private listeners: AlertListener[] = [];
  private pruneTimer?: NodeJS.Timeout;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly keepDays = envNumber('SENSOR_HISTORY_DAYS', 30);

  constructor(@Optional() @Inject(AuthService) private auth?: AuthService) {}

  async onModuleInit() {
    if (!this.auth) return;
    const storage = await this.auth.storage();
    this.db = storage.db;
    if (storage.dir) {
      this.settingsFile = join(storage.dir, 'alert-settings.json');
      if (existsSync(this.settingsFile)) {
        try { this.settings = validateAlertSettings(defaultAlertSettings(), JSON.parse(readFileSync(this.settingsFile, 'utf8'))); }
        catch (error) { console.warn(`[Sensor] Ignoring ${this.settingsFile}: ${(error as Error).message}`); }
      }
    }
    void this.prune();
    this.pruneTimer = setInterval(() => void this.prune(), 3_600_000);
    this.pruneTimer.unref();
  }

  async onModuleDestroy() {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    for (const [deviceId, bucket] of this.buckets) this.flush(deviceId, bucket);
    this.buckets.clear();
    await this.writes;
  }

  onAlert(listener: AlertListener) { this.listeners.push(listener); }
  getSettings(): AlertSettings { return { ...this.settings }; }

  /** Applies new limits (validated), saves them, and re-checks the active alerts right away. */
  updateSettings(input: unknown): AlertSettings {
    this.settings = validateAlertSettings(this.settings, input);
    if (this.settingsFile) writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
    for (const [deviceId, kinds] of this.alertState) {
      for (const [kind, state] of kinds) {
        state.pendingSince = undefined;
        if (state.active && (!this.settings.enabled || !this.violates(kind, state.active.value, true))) this.clear(deviceId, kind, state);
      }
    }
    return this.getSettings();
  }

  activeAlerts(deviceId: string): ActiveAlert[] {
    return [...(this.alertState.get(deviceId)?.values() ?? [])].flatMap(s => s.active ? [{ ...s.active }] : []);
  }

  /** One sensor report from a device. */
  record(deviceId: string, temperature: number, humidity: number, at = Date.now()) {
    const minute = Math.floor(at / 60_000) * 60_000;
    let bucket = this.buckets.get(deviceId);
    if (bucket && bucket.minute !== minute) { this.flush(deviceId, bucket); bucket = undefined; }
    if (!bucket) {
      bucket = { minute, n: 0, tSum: 0, hSum: 0, tMin: temperature, tMax: temperature, hMin: humidity, hMax: humidity };
      this.buckets.set(deviceId, bucket);
    }
    bucket.n++; bucket.tSum += temperature; bucket.hSum += humidity;
    bucket.tMin = Math.min(bucket.tMin, temperature); bucket.tMax = Math.max(bucket.tMax, temperature);
    bucket.hMin = Math.min(bucket.hMin, humidity); bucket.hMax = Math.max(bucket.hMax, humidity);
    this.evaluate(deviceId, temperature, humidity, at);
  }

  /** History of one device, averaged into buckets that fit the range (≤ 360 points). */
  async history(deviceId: string, range: HistoryRange, now = Date.now()) {
    const { ms, bucketMinutes } = HISTORY_RANGES[range];
    const from = new Date(now - ms);
    await this.writes;
    const rows: HistoryPoint[] = this.db ? (await this.repo().find({
      where: { deviceId, at: MoreThanOrEqual(from) }, order: { at: 'ASC' },
    })).map(r => ({
      at: new Date(r.at).toISOString(), temperature: r.temperature, humidity: r.humidity,
      temperatureMin: r.temperatureMin, temperatureMax: r.temperatureMax,
      humidityMin: r.humidityMin, humidityMax: r.humidityMax, samples: r.samples,
    })) : [];
    const open = this.buckets.get(deviceId);
    if (open && open.minute >= from.getTime()) rows.push(this.point(open));
    return { range, bucketMinutes, points: downsample(rows, bucketMinutes) };
  }

  // ------------------------------------------------------------------ internals

  private repo() { return this.db!.getRepository<SensorReading>('SensorReading'); }

  private point(b: Bucket): HistoryPoint {
    const round = (v: number) => Math.round(v * 100) / 100;
    return {
      at: new Date(b.minute).toISOString(), temperature: round(b.tSum / b.n), humidity: round(b.hSum / b.n),
      temperatureMin: b.tMin, temperatureMax: b.tMax, humidityMin: b.hMin, humidityMax: b.hMax, samples: b.n,
    };
  }

  private flush(deviceId: string, bucket: Bucket) {
    if (!this.db || !bucket.n) return;
    const p = this.point(bucket);
    const row: SensorReading = { id: `${deviceId}:${bucket.minute}`, deviceId, ...p, at: new Date(bucket.minute) };
    // Writes are chained so a query never misses a minute that is still being saved.
    this.writes = this.writes.then(() => this.repo().save(row))
      .catch(error => console.warn(`[Sensor] History write failed: ${(error as Error).message}`));
  }

  private async prune() {
    if (!this.db || !(this.keepDays > 0)) return;
    try { await this.repo().delete({ at: LessThan(new Date(Date.now() - this.keepDays * 86_400_000)) }); }
    catch (error) { console.warn(`[Sensor] History cleanup failed: ${(error as Error).message}`); }
  }

  /** stillActive: with the hysteresis margin (used while an alert is active). */
  private violates(kind: AlertKind, value: number, stillActive = false): boolean {
    const s = this.settings;
    const margin = stillActive ? (kind.startsWith('temperature') ? MARGIN.temperature : MARGIN.humidity) : 0;
    switch (kind) {
      case 'temperature_high': return value > s.temperatureHigh - margin;
      case 'temperature_low': return value < s.temperatureLow + margin;
      case 'humidity_high': return value > s.humidityHigh - margin;
      case 'humidity_low': return value < s.humidityLow + margin;
    }
  }
  private threshold(kind: AlertKind) {
    const s = this.settings;
    return { temperature_high: s.temperatureHigh, temperature_low: s.temperatureLow,
      humidity_high: s.humidityHigh, humidity_low: s.humidityLow }[kind];
  }

  private evaluate(deviceId: string, temperature: number, humidity: number, now: number) {
    if (!this.settings.enabled) return;
    const kinds = this.alertState.get(deviceId) ?? this.alertState.set(deviceId, new Map()).get(deviceId)!;
    for (const kind of KINDS) {
      const value = kind.startsWith('temperature') ? temperature : humidity;
      const state = kinds.get(kind) ?? kinds.set(kind, {}).get(kind)!;
      if (state.active) {
        if (this.violates(kind, value, true)) { state.active.value = value; continue; }
        this.clear(deviceId, kind, state);
        continue;
      }
      if (!this.violates(kind, value)) { state.pendingSince = undefined; continue; }
      state.pendingSince ??= now;
      if (now - state.pendingSince < this.settings.holdSeconds * 1000) continue;
      const threshold = this.threshold(kind);
      const unit = kind.startsWith('temperature') ? '°C' : '%';
      const fmt = (v: number) => v.toFixed(1).replace('.', ',');
      state.active = {
        kind, value, threshold, since: new Date(now).toISOString(),
        message: `${LABEL[kind]}: ${fmt(value)} ${unit} (ngưỡng ${fmt(threshold)} ${unit})`,
      };
      state.pendingSince = undefined;
      this.emit(deviceId, state.active, true);
    }
  }

  private clear(deviceId: string, _kind: AlertKind, state: KindState) {
    const alert = state.active!;
    state.active = undefined;
    this.emit(deviceId, alert, false);
  }

  private emit(deviceId: string, alert: ActiveAlert, raised: boolean) {
    const { kind, value, threshold } = alert;
    const unit = kind.startsWith('temperature') ? '°C' : '%';
    void this.auth?.audit({
      source: 'system', username: 'Hệ thống', deviceId, action: raised ? `alert:${kind}` : `alert:${kind}:clear`,
      detail: raised ? alert.message : `${LABEL[kind]} đã trở lại bình thường: ${value.toFixed(1)} ${unit} (ngưỡng ${threshold} ${unit})`,
    });
    for (const listener of this.listeners) {
      try { listener(deviceId, { ...alert }, raised); }
      catch (error) { console.warn(`[Sensor] Alert listener failed: ${(error as Error).message}`); }
    }
  }
}
