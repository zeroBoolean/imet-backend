import type { Store, IncrementResponse } from 'express-rate-limit';
import { createRedisConnection } from '../../emails/redisConnection.js';
// Shared counters make auth limits effective across API replicas. General catalogue
// rate limiting is deliberately unchanged by this M1-only task.
const connection = createRedisConnection();
connection.on('error', () => undefined);
connection.on('ready', () => {
  const stream = (
    connection as unknown as { connector: { stream?: { unref(): void } } }
  ).connector.stream;
  stream?.unref();
});
export class AuthRateStore implements Store {
  localKeys = false;
  private windowMs = 900000;
  constructor(public prefix: string) {}
  init(options: { windowMs: number }) {
    this.windowMs = options.windowMs;
  }
  async increment(key: string): Promise<IncrementResponse> {
    const result = (await connection.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return {n,redis.call('PTTL',KEYS[1])}",
      1,
      `${this.prefix}:${key}`,
      this.windowMs,
    )) as [number, number];
    return {
      totalHits: result[0],
      resetTime: new Date(Date.now() + Math.max(0, result[1])),
    };
  }
  async decrement(key: string) {
    await connection.decr(`${this.prefix}:${key}`);
  }
  async resetKey(key: string) {
    await connection.del(`${this.prefix}:${key}`);
  }
}
export async function closeAuthRateStore() {
  await connection.quit();
}
