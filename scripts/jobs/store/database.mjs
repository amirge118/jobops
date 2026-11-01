import { AsyncLocalStorage } from 'node:async_hooks';

import Database from 'better-sqlite3';

// The one module that knows the storage driver. Repositories only use this
// async surface — prepare(sql).get/all/run, exec, transaction, close — which a
// Postgres driver can implement too.
//
// Statements still run synchronously when nothing is in the way, so a write
// made from a process-exit handler reaches the disk. One connection can hold
// one transaction: while it is open, calls from outside it wait their turn
// instead of joining it by accident.
export function openSqliteDatabase(databasePath, { readonly = false } = {}) {
  const raw = new Database(databasePath, readonly ? { readonly: true, fileMustExist: true } : {});
  if (!readonly) raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  // WAL allows concurrent readers but still only one writer at a time. The
  // single-instance scan lock (see jobs/single-instance.mjs) keeps two scans
  // from overlapping, but a short-lived writer (a dashboard action, a probe)
  // can still legitimately hold a write transaction for a moment — wait
  // rather than fail outright on that brief contention.
  raw.pragma('busy_timeout = 5000');

  const transactionContext = new AsyncLocalStorage();
  let openTransaction = null;
  let savepoints = 0;

  const whenFree = (operation) => {
    if (!openTransaction || transactionContext.getStore()) {
      try {
        return Promise.resolve(operation());
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return openTransaction.then(() => whenFree(operation));
  };

  const runNested = async (callback, args) => {
    savepoints += 1;
    const name = `nested_${savepoints}`;
    raw.exec(`SAVEPOINT ${name}`);
    try {
      const result = await callback(...args);
      raw.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      raw.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw error;
    }
  };

  const runTopLevel = async (callback, args) => {
    while (openTransaction) await openTransaction;
    let finish;
    openTransaction = new Promise((resolve) => { finish = resolve; });
    try {
      // IMMEDIATE: a deferred read that later upgrades to a write fails at once
      // under contention instead of waiting out busy_timeout.
      raw.exec('BEGIN IMMEDIATE');
      const result = await transactionContext.run(true, () => callback(...args));
      raw.exec('COMMIT');
      return result;
    } catch (error) {
      if (raw.inTransaction) raw.exec('ROLLBACK');
      throw error;
    } finally {
      openTransaction = null;
      finish();
    }
  };

  return {
    raw,

    prepare(sql) {
      let statement = null;
      const compiled = () => { statement ??= raw.prepare(sql); return statement; };
      return {
        get: (...params) => whenFree(() => compiled().get(...params)),
        all: (...params) => whenFree(() => compiled().all(...params)),
        run: (...params) => whenFree(() => compiled().run(...params)),
      };
    },

    exec: (sql) => whenFree(() => { raw.exec(sql); }),

    // Returns an async function, like better-sqlite3's transaction() does a sync
    // one. Nested calls join the open transaction through a savepoint.
    transaction(callback) {
      return (...args) => (transactionContext.getStore() ? runNested(callback, args) : runTopLevel(callback, args));
    },

    close() {
      raw.close();
      return Promise.resolve();
    },
  };
}
