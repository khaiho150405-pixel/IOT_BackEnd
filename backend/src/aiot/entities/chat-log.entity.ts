import { EntitySchema } from 'typeorm';

export interface ChatLog {
  id: string;
  deviceId: string;
  transcript: string;
  reply: string;
  intent: string;
  createdAt: Date;
}
export const ChatLogEntity = new EntitySchema<ChatLog>({
  name: 'ChatLog', tableName: 'aiot_chat_log',
  columns: {
    id: { type: 'uuid', primary: true },
    deviceId: { type: String, length: 64 },
    transcript: { type: 'text' }, reply: { type: 'text' },
    intent: { type: String, length: 64 }, createdAt: { type: 'timestamptz' },
  },
});
