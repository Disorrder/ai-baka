import { Database } from "bun:sqlite";

// Recognize observed service schemas, not filenames/extensions. New tables remain
// unsupported until inspected: a future transcript table must not disappear.
const PROFILES = [
  { marker: "threads", columns: ["id", "rollout_path", "cwd", "first_user_message"], tables: ["threads", "thread_dynamic_tools", "backfill_state", "agent_jobs", "agent_job_items", "thread_spawn_edges", "remote_control_enrollments"] },
  { marker: "thread_goals", columns: ["thread_id", "goal_id", "objective", "status"], tables: ["thread_goals"] },
  { marker: "stage1_outputs", columns: ["thread_id", "raw_memory", "rollout_summary"], tables: ["stage1_outputs", "jobs"] },
  { marker: "logs", columns: ["ts", "level", "target", "feedback_log_body"], tables: ["logs"] },
  { marker: "automation_runs", columns: ["thread_id", "automation_id", "archived_user_message", "archived_assistant_message"], tables: ["inbox_items", "automations", "automation_runs", "local_app_server_feature_enablement", "local_thread_catalog_sync_state", "local_thread_catalog_metadata", "thread_timeline_ledger", "local_thread_catalog", "local_thread_catalog_hosts", "local_thread_catalog_scan_checkpoints", "local_thread_catalog_scan_entries"] },
];

export function isCodexMetadataSqlite(snapshotPath: string): boolean {
  const db = new Database(snapshotPath, { readonly: true, create: false });
  try {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    for (const profile of PROFILES) {
      if (!tables.some(({ name }) => name === profile.marker)) continue;
      if (tables.some(({ name }) => !["_sqlx_migrations", "sqlite_stat1", "sqlite_stat4", "sqlite_sequence"].includes(name) && !profile.tables.includes(name))) continue;
      const columns = db.query(`PRAGMA table_info("${profile.marker}")`).all() as { name: string }[];
      if (!profile.columns.every((column) => columns.some(({ name }) => name === column))) continue;
      if (profile.marker === "automation_runs") {
        // These columns can hold genuine archived replies. The observed snapshots
        // have only NULLs; do not classify future populated archives as metadata.
        if (db.query("SELECT 1 FROM automation_runs WHERE length(trim(coalesce(archived_user_message, ''))) > 0 OR length(trim(coalesce(archived_assistant_message, ''))) > 0 LIMIT 1").get()) return false;
        if (tables.some(({ name }) => name === "thread_timeline_ledger") && db.query("SELECT 1 FROM thread_timeline_ledger LIMIT 1").get()) return false;
      }
      return true;
    }
    return false;
  } finally {
    db.close();
  }
}
