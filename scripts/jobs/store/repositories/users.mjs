import { parseJson } from '../shared.mjs';

export function createUsersRepository({ db }) {
  return {
    async getUser(userId) {
      const row = await db.prepare('SELECT id, display_name, created_at FROM users WHERE id = ?').get(userId);
      return row ? { id: row.id, displayName: row.display_name, createdAt: row.created_at } : null;
    },

    async listUserSettings(userId) {
      const rows = await db.prepare('SELECT key, value_json FROM user_settings WHERE user_id = ?').all(userId);
      return Object.fromEntries(rows.map((row) => [row.key, parseJson(row.value_json)]));
    },

    async saveUserSetting(userId, key, value, at = Date.now()) {
      await db.prepare(`
        INSERT INTO user_settings (user_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run(userId, key, JSON.stringify(value), at);
    },

    async deleteUserSetting(userId, key) {
      return (await db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?').run(userId, key)).changes > 0;
    },
  };
}
