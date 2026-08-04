-- 0009_codex_lineage.surql
-- Производный cache lineage для Codex subagent. Поля восстанавливаются из
-- immutable session_meta и не являются частью identity dialogue_revision.

DEFINE FIELD IF NOT EXISTS parent_source_dialogue_id ON TABLE dialogue_revision TYPE option<string>;
DEFINE FIELD IF NOT EXISTS agent_depth ON TABLE dialogue_revision TYPE option<int>;
DEFINE FIELD IF NOT EXISTS agent_nickname ON TABLE dialogue_revision TYPE option<string>;
DEFINE FIELD IF NOT EXISTS agent_role ON TABLE dialogue_revision TYPE option<string>;
DEFINE INDEX IF NOT EXISTS dialogue_revision_parent_source_dialogue_id ON TABLE dialogue_revision FIELDS parent_source_dialogue_id;
