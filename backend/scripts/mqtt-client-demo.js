/**
 * Demo MQTT Client for AIoT Smart Room
 * Usage:
 *   node scripts/mqtt-client-demo.js monitor                 (Theo dõi cảm biến & trạng thái)
 *   node scripts/mqtt-client-demo.js on                      (Bật đèn LED)
 *   node scripts/mqtt-client-demo.js off                     (Tắt đèn LED)
 *   node scripts/mqtt-client-demo.js ask "Nhiệt độ bao nhiêu?" (Hỏi AI)
 */

const mqtt = require('mqtt');

const host = process.env.MQTT_HOST || '127.0.0.1';
const port = process.env.MQTT_PORT || 1883;
const url = `mqtt://${host}:${port}`;

console.log(`[MQTT Demo] Đang kết nối tới ${url}...`);
const client = mqtt.connect(url, {
  clientId: `demo_client_${Math.random().toString(16).slice(2, 6)}`,
  clean: true,
  connectTimeout: 5000,
});

const argCmd = process.argv[2] ? process.argv[2].toLowerCase() : 'monitor';
const argText = process.argv.slice(3).join(' ');

client.on('connect', () => {
  console.log(`[MQTT Demo] Đã kết nối thành công tới MQTT Broker!`);

  client.subscribe(['aiot/sensor', 'aiot/state', 'aiot/chat', 'aiot/response', 'aiot/led/status'], err => {
    if (err) console.error('[MQTT Demo] Lỗi đăng ký topic:', err.message);
    else console.log('[MQTT Demo] Đang lắng nghe: aiot/sensor, aiot/state, aiot/chat, aiot/response');
  });

  if (argCmd === 'on' || argCmd === 'bat') {
    console.log('[MQTT Demo] Gửi lệnh BẬT ĐÈN...');
    client.publish('aiot/led/set', 'on', { qos: 1 });
  } else if (argCmd === 'off' || argCmd === 'tat') {
    console.log('[MQTT Demo] Gửi lệnh TẮT ĐÈN...');
    client.publish('aiot/led/set', 'off', { qos: 1 });
  } else if (argCmd === 'ask' || argCmd === 'hoi') {
    const question = argText || 'Nhiệt độ phòng là bao nhiêu?';
    console.log(`[MQTT Demo] Gửi câu lệnh AI: "${question}"...`);
    client.publish('aiot/command', JSON.stringify({ action: 'text', text: question }), { qos: 1 });
  } else {
    console.log('[MQTT Demo] Chế độ giám sát real-time. Nhấn Ctrl+C để thoát.');
  }
});

client.on('message', (topic, payload) => {
  const content = payload.toString('utf8');
  const now = new Date().toLocaleTimeString();
  console.log(`\n[${now}] 📩 Nhận từ topic [${topic}]:`);
  try {
    const json = JSON.parse(content);
    console.dir(json, { depth: null, colors: true });
  } catch {
    console.log('   ', content);
  }

  // Tự động ngắt sau khi gửi lệnh on/off nếu không ở chế độ monitor
  if (['on', 'off', 'bat', 'tat'].includes(argCmd) && topic.includes('response')) {
    setTimeout(() => {
      console.log('\n[MQTT Demo] Hoàn tất lệnh.');
      client.end();
      process.exit(0);
    }, 500);
  }
});

client.on('error', err => {
  console.error('[MQTT Demo] Lỗi kết nối MQTT:', err.message);
});
