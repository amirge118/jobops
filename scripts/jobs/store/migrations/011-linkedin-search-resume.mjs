// Where a search that stopped early continues: the result offset it reached, and
// the moment its reading began, which is as far as finishing it can cover.
export function up(db) {
  db.exec(`
    ALTER TABLE linkedin_search_progress ADD COLUMN resume_start INTEGER;
    ALTER TABLE linkedin_search_progress ADD COLUMN resume_to INTEGER;
  `);
}
