export function createCheckpointsRepository({ db }) {
  return {
    async getCheckpoint(sourceKey) {
      return (await db.prepare('SELECT last_timestamp FROM checkpoints WHERE source_key = ?').get(sourceKey))?.last_timestamp ?? null;
    },

    async setCheckpoint(sourceKey, timestamp) {
      await db.prepare(`
        INSERT INTO checkpoints (source_key, last_timestamp) VALUES (?, ?)
        ON CONFLICT(source_key) DO UPDATE SET last_timestamp = excluded.last_timestamp
        WHERE excluded.last_timestamp > checkpoints.last_timestamp
      `).run(sourceKey, timestamp);
    },
  };
}
