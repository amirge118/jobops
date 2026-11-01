function mapApplication(row) {
  return {
    number: row.number, numberLabel: row.number_label, date: row.applied_on, company: row.company, role: row.role,
    companyRoleKey: row.company_role_key, score: row.score, status: row.status, pdf: row.pdf, report: row.report,
    notes: row.notes, updatedAt: row.updated_at,
  };
}

export function createApplicationsRepository({ db }) {
  const write = (userId, row, at) => db.prepare(`
    INSERT INTO applications (user_id, number, number_label, applied_on, company, role, company_role_key, score, status, pdf, report, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, number) DO UPDATE SET
      number_label = excluded.number_label, applied_on = excluded.applied_on, company = excluded.company, role = excluded.role,
      company_role_key = excluded.company_role_key, score = excluded.score, status = excluded.status, pdf = excluded.pdf,
      report = excluded.report, notes = excluded.notes, updated_at = excluded.updated_at
  `).run(userId, row.number, row.numberLabel, row.date, row.company, row.role, row.companyRoleKey, row.score, row.status, row.pdf, row.report, row.notes, at);

  return {
    async listApplications(userId) {
      return (await db.prepare('SELECT * FROM applications WHERE user_id = ? ORDER BY number').all(userId)).map(mapApplication);
    },

    async getApplication(userId, number) {
      const row = await db.prepare('SELECT * FROM applications WHERE user_id = ? AND number = ?').get(userId, number);
      return row ? mapApplication(row) : null;
    },

    async findApplicationByIdentity(userId, companyRoleKey) {
      const row = await db.prepare('SELECT * FROM applications WHERE user_id = ? AND company_role_key = ? ORDER BY number LIMIT 1').get(userId, companyRoleKey);
      return row ? mapApplication(row) : null;
    },

    async nextApplicationNumber(userId) {
      return ((await db.prepare('SELECT MAX(number) AS number FROM applications WHERE user_id = ?').get(userId)).number ?? 0) + 1;
    },

    async saveApplication(userId, row, at = Date.now()) {
      await write(userId, row, at);
    },

    // The whole list at once, as importing or adopting a file means.
    async replaceApplications(userId, rows, at = Date.now()) {
      await db.transaction(async () => {
        await db.prepare('DELETE FROM applications WHERE user_id = ?').run(userId);
        for (const row of rows) await write(userId, row, at);
      })();
    },
  };
}
