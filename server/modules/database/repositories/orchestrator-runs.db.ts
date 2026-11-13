import { getConnection } from '@/modules/database/connection.js';

/** How many runs are kept; older ones are dropped on save. */
const MAX_STORED_RUNS = 50;

/**
 * Orchestrated tasks as the orchestrator module last saved them. The state
 * is that module's own JSON and is not interpreted here. Used only by the
 * orchestrator module, so a task survives a server restart.
 */
export const orchestratorRunsDb = {
  /** Inserts or replaces one run, then trims the table to the newest `MAX_STORED_RUNS`. */
  save(id: string, sessionId: string, state: unknown): void {
    const db = getConnection();
    db.prepare(
      `INSERT INTO orchestrator_runs (id, session_id, state)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = CURRENT_TIMESTAMP`
    ).run(id, sessionId, JSON.stringify(state));
    db.prepare(
      `DELETE FROM orchestrator_runs WHERE id NOT IN (
         SELECT id FROM orchestrator_runs ORDER BY created_at DESC, rowid DESC LIMIT ?
       )`
    ).run(MAX_STORED_RUNS);
  },

  /** Every stored run's state, oldest first; a row whose JSON no longer parses is skipped. */
  listStates(): unknown[] {
    const rows = getConnection()
      .prepare('SELECT state FROM orchestrator_runs ORDER BY created_at ASC, rowid ASC')
      .all() as Array<{ state: string }>;
    const states: unknown[] = [];
    for (const row of rows) {
      try {
        states.push(JSON.parse(row.state));
      } catch {
        // An unreadable run is simply not restored.
      }
    }
    return states;
  },

  /** Removes every stored run. Used by the orchestrator module's tests. */
  clear(): void {
    getConnection().prepare('DELETE FROM orchestrator_runs').run();
  },
};
