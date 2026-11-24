import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthService } from '../src/auth/auth.service';
import { ActiveAlert, SensorMonitor, defaultAlertSettings, downsample, validateAlertSettings } from '../src/aiot/sensor-monitor';

process.env.AUTH_DB_FILE = ':memory:';
process.env.DATABASE_URL = '';

async function monitorWithDb() {
  const auth = new AuthService();
  const monitor = new SensorMonitor(auth);
  await monitor.onModuleInit();
  return { auth, monitor };
}

test('history: one row per minute, averaged/min/max, ranges downsample, open minute included', async t => {
  const { auth, monitor } = await monitorWithDb();
  t.after(async () => { await monitor.onModuleDestroy(); await auth.onModuleDestroy(); });
  const start = Date.UTC(2026, 0, 1, 10, 0, 0);
  // 3 minutes of reports every 2 s: 30 °C, 31 °C, 32 °C (+ noise on humidity).
  for (let m = 0; m < 3; m++)
    for (let s = 0; s < 60; s += 2) monitor.record('dev', 30 + m, 60 + (s % 4 ? 1 : -1), start + m * 60_000 + s * 1000);
  const now = start + 3 * 60_000 - 1000;
  const hour = await monitor.history('dev', '1h', now);
  assert.equal(hour.bucketMinutes, 1);
  assert.equal(hour.points.length, 3, 'two saved minutes + the open one');
  assert.deepEqual(hour.points.map(p => p.temperature), [30, 31, 32]);
  assert.equal(hour.points[0].humidityMin, 59);
  assert.equal(hour.points[0].humidityMax, 61);
  assert.equal(hour.points[0].samples, 30);
  const day = await monitor.history('dev', '24h', now);
  assert.equal(day.bucketMinutes, 5);
  assert.equal(day.points.length, 1);
  assert.equal(day.points[0].temperature, 31);
  assert.equal(day.points[0].temperatureMin, 30);
  assert.equal(day.points[0].temperatureMax, 32);
  assert.deepEqual((await monitor.history('other', '1h', now)).points, []);
  // Outside the range: nothing.
  assert.deepEqual((await monitor.history('dev', '1h', start + 5 * 3_600_000)).points, []);
});

test('downsample weights by sample count', () => {
  const row = (at: string, temperature: number, samples: number) => ({ at, temperature, humidity: 50,
    temperatureMin: temperature, temperatureMax: temperature, humidityMin: 50, humidityMax: 50, samples });
  const [point] = downsample([row('2026-01-01T00:00:00Z', 20, 1), row('2026-01-01T00:01:00Z', 30, 3)], 5);
  assert.equal(point.temperature, 27.5);
  assert.equal(point.samples, 4);
});

test('alert settings are validated', () => {
  const base = defaultAlertSettings();
  assert.equal(validateAlertSettings(base, { temperatureHigh: '30.25' }).temperatureHigh, 30.3);
  assert.throws(() => validateAlertSettings(base, { temperatureHigh: 'abc' }), /số/);
  assert.throws(() => validateAlertSettings(base, { temperatureLow: 40, temperatureHigh: 35 }), /nhỏ hơn/);
  assert.throws(() => validateAlertSettings(base, { humidityHigh: 101 }), /1 đến 100/);
  assert.throws(() => validateAlertSettings(base, { enabled: 'yes' }), /true hoặc false/);
});

test('alerts: raised after holdSeconds, kept with hysteresis, cleared, audited; settings re-check', async t => {
  const { auth, monitor } = await monitorWithDb();
  t.after(async () => { await monitor.onModuleDestroy(); await auth.onModuleDestroy(); });
  monitor.updateSettings({ enabled: true, temperatureHigh: 30, temperatureLow: 15, humidityHigh: 80, humidityLow: 20, holdSeconds: 10 });
  const events: Array<[ActiveAlert, boolean]> = [];
  monitor.onAlert((_id, alert, raised) => events.push([alert, raised]));
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  monitor.record('dev', 31, 50, t0);
  monitor.record('dev', 31.2, 50, t0 + 8_000);
  assert.equal(monitor.activeAlerts('dev').length, 0, 'not yet: below holdSeconds');
  monitor.record('dev', 29, 50, t0 + 9_000);          // one normal reading resets the wait
  monitor.record('dev', 31, 50, t0 + 10_000);
  monitor.record('dev', 31, 50, t0 + 19_000);
  assert.equal(monitor.activeAlerts('dev').length, 0);
  monitor.record('dev', 31.4, 50, t0 + 20_000);
  const [alert] = monitor.activeAlerts('dev');
  assert.equal(alert.kind, 'temperature_high');
  assert.match(alert.message, /Nhiệt độ cao: 31,4 °C \(ngưỡng 30,0 °C\)/);
  assert.equal(events.length, 1); assert.equal(events[0][1], true);
  monitor.record('dev', 29.8, 50, t0 + 22_000);       // inside the 0.5 °C margin: still active
  assert.equal(monitor.activeAlerts('dev')[0].value, 29.8);
  monitor.record('dev', 29.4, 50, t0 + 24_000);       // back inside by the margin: cleared
  assert.equal(monitor.activeAlerts('dev').length, 0);
  assert.equal(events.length, 2); assert.equal(events[1][1], false);
  // Humidity low, then raising the limit above the value clears it at once.
  for (let s = 0; s <= 10; s += 2) monitor.record('dev', 25, 15, t0 + 60_000 + s * 1000);
  assert.equal(monitor.activeAlerts('dev')[0].kind, 'humidity_low');
  monitor.updateSettings({ humidityLow: 10 });
  assert.equal(monitor.activeAlerts('dev').length, 0);
  // Disabled: nothing is raised.
  monitor.updateSettings({ enabled: false });
  for (let s = 0; s <= 20; s += 2) monitor.record('dev', 40, 50, t0 + 120_000 + s * 1000);
  assert.equal(monitor.activeAlerts('dev').length, 0);
  await new Promise(resolve => setTimeout(resolve, 50));
  const owner = await auth.setup({ username: 'owner', password: 'owner-pass-123', displayName: 'Chủ' } as any);
  const actions = (await auth.listAudit(owner as any, 50)).map(e => e.action);
  assert.ok(actions.includes('alert:temperature_high'));
  assert.ok(actions.includes('alert:temperature_high:clear'));
  assert.ok(actions.includes('alert:humidity_low'));
});
