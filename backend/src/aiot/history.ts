import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { DataSource, MigrationInterface, QueryRunner } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { ChatLog, ChatLogEntity } from './entities/chat-log.entity';

class InitialAiot1700000000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE "aiot_chat_log" (
      "id" uuid PRIMARY KEY, "deviceId" varchar(64) NOT NULL,
      "transcript" text NOT NULL, "reply" text NOT NULL,
      "intent" varchar(64) NOT NULL, "createdAt" timestamptz NOT NULL)`);
    await q.query('CREATE INDEX ON "aiot_chat_log" ("deviceId", "createdAt" DESC)');
  }
  async down(q: QueryRunner) { await q.query('DROP TABLE "aiot_chat_log"'); }
}

@Injectable()
export class HistoryStore implements OnModuleInit, OnModuleDestroy {
  private db?: DataSource;
  private memory = new Map<string, ChatLog[]>();
  async onModuleInit() {
    if (!process.env.DATABASE_URL) {
      console.warn('DATABASE_URL empty: conversation history is in memory only.');
      return;
    }
    this.db = new DataSource({ type: 'postgres', url: process.env.DATABASE_URL,
      entities: [ChatLogEntity], migrations: [InitialAiot1700000000000],
      migrationsRun: true, synchronize: false });
    await this.db.initialize();
  }
  async recent(deviceId: string): Promise<ChatLog[]> {
    if (this.db) return (await this.db.getRepository(ChatLogEntity).find({
      where: { deviceId }, order: { createdAt: 'DESC' }, take: 5,
    })).reverse();
    return this.memory.get(deviceId) || [];
  }
  async add(deviceId: string, transcript: string, reply: string, intent: string) {
    const row = { id: randomUUID(), deviceId, transcript, reply, intent, createdAt: new Date() };
    if (this.db) { await this.db.getRepository(ChatLogEntity).save(row); return; }
    if (!this.memory.has(deviceId) && this.memory.size >= 100) this.memory.delete(this.memory.keys().next().value!);
    this.memory.set(deviceId, [...(this.memory.get(deviceId) || []), row].slice(-5));
  }
  async onModuleDestroy() { if (this.db?.isInitialized) await this.db.destroy(); }
}
