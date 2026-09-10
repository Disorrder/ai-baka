export const SQLITE_EXPORT_FORMAT = "ai-baka-analytical-export";
export const SQLITE_EXPORT_VERSION = 1;
export const EXPORT_SCHEMA = `
PRAGMA foreign_keys=ON;
PRAGMA journal_mode=DELETE;
PRAGMA synchronous=FULL;
PRAGMA cache_size=-32768;
PRAGMA user_version=${SQLITE_EXPORT_VERSION};
CREATE TABLE export_info(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE data_dictionary(name TEXT PRIMARY KEY, description TEXT NOT NULL);
CREATE TABLE corpus_manifest(revision_ref TEXT PRIMARY KEY, dialogue_ref TEXT NOT NULL, source_revision_ref TEXT, canonical_hash TEXT NOT NULL, message_count INTEGER NOT NULL, chunk_count INTEGER NOT NULL, is_current INTEGER NOT NULL);
CREATE TABLE hosts(id TEXT PRIMARY KEY, label TEXT, platform TEXT, arch TEXT);
CREATE TABLE models(id TEXT PRIMARY KEY, vendor TEXT, canonical_name TEXT);
CREATE TABLE dialogues(id TEXT PRIMARY KEY, harness TEXT NOT NULL, harness_installation TEXT NOT NULL, host_id TEXT REFERENCES hosts, workspace_id TEXT, title TEXT);
CREATE TABLE dialogue_revisions(id TEXT PRIMARY KEY, dialogue_id TEXT NOT NULL REFERENCES dialogues, source_revision TEXT, parser_name TEXT, parser_version TEXT, canonical_hash TEXT, is_current INTEGER NOT NULL, source_dialogue_ref TEXT, parent_source_dialogue_ref TEXT, instructions_status TEXT NOT NULL);
CREATE TABLE messages(id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES dialogue_revisions, sequence INTEGER NOT NULL, role TEXT NOT NULL, raw_role TEXT, timestamp TEXT, model_id TEXT REFERENCES models, service_provider TEXT, reasoning_effort TEXT, response_status TEXT, human_authored TEXT NOT NULL, visible_to_user TEXT NOT NULL, context_included INTEGER NOT NULL, UNIQUE(revision_id,sequence));
CREATE TABLE chunks(id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages, sequence INTEGER NOT NULL, kind TEXT NOT NULL, raw_kind TEXT, source_locator TEXT, tool_call_id TEXT, tool_name TEXT, content TEXT, UNIQUE(message_id,sequence));
CREATE TABLE items(id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages, sequence INTEGER NOT NULL, chunk_sequence INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, category TEXT NOT NULL, origin TEXT NOT NULL, layer TEXT NOT NULL, classification TEXT NOT NULL, reason TEXT NOT NULL, extraction_method TEXT NOT NULL, turn_id TEXT, matched INTEGER NOT NULL, context_included INTEGER NOT NULL);
CREATE TABLE item_sources(item_id TEXT NOT NULL REFERENCES items, chunk_id TEXT NOT NULL REFERENCES chunks, PRIMARY KEY(item_id,chunk_id));
CREATE TABLE analysis_items(item_id TEXT PRIMARY KEY REFERENCES items, content TEXT);
CREATE TABLE instructions(id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT, observation_status TEXT NOT NULL);
CREATE TABLE instruction_applications(item_id TEXT PRIMARY KEY REFERENCES items, instruction_id TEXT NOT NULL REFERENCES instructions, revision_id TEXT NOT NULL REFERENCES dialogue_revisions, message_id TEXT NOT NULL REFERENCES messages, scope TEXT NOT NULL);
CREATE TABLE review_items(item_id TEXT PRIMARY KEY REFERENCES items, reason TEXT NOT NULL, content TEXT);
CREATE TABLE relations(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, from_item TEXT REFERENCES items, to_item TEXT REFERENCES items, from_revision TEXT REFERENCES dialogue_revisions, to_revision TEXT REFERENCES dialogue_revisions, external_ref TEXT, status TEXT NOT NULL);
CREATE INDEX messages_time ON messages(timestamp);
CREATE INDEX messages_model ON messages(model_id);
CREATE INDEX chunks_call ON chunks(tool_call_id);
CREATE INDEX items_message ON items(message_id,chunk_sequence);
CREATE INDEX revisions_dialogue ON dialogue_revisions(dialogue_id);
CREATE INDEX items_turn ON items(turn_id);
CREATE VIEW v_item_source_counts AS
 SELECT s.item_id,count(DISTINCT c.message_id) AS source_message_count
 FROM item_sources s JOIN chunks c ON c.id=s.chunk_id GROUP BY s.item_id;
CREATE VIEW v_analysis_messages AS
 SELECT d.id AS dialogue_id, r.id AS revision_id, i.id AS item_id, m.id AS message_id,
 m.sequence, i.chunk_sequence, i.role, i.category, a.content, m.timestamp, d.harness,
 d.host_id, CASE WHEN coalesce(sc.source_message_count,1)=1 THEN mo.canonical_name END AS model,
 CASE WHEN coalesce(sc.source_message_count,1)=1 THEN mo.vendor END AS vendor,
 CASE WHEN coalesce(sc.source_message_count,1)=1 THEN m.service_provider END AS service_provider,
 CASE WHEN coalesce(sc.source_message_count,1)=1 THEN m.reasoning_effort END AS reasoning_effort,
 m.response_status, i.classification, i.reason, i.extraction_method, i.turn_id, i.context_included,
 coalesce(sc.source_message_count,1) AS source_message_count,
 CASE WHEN coalesce(sc.source_message_count,1)=1 THEN 'single_source' ELSE 'multiple_sources_see_item_sources' END AS attribution_status
 FROM analysis_items a JOIN items i ON i.id=a.item_id JOIN messages m ON m.id=i.message_id
 JOIN dialogue_revisions r ON r.id=m.revision_id JOIN dialogues d ON d.id=r.dialogue_id
 LEFT JOIN models mo ON mo.id=m.model_id LEFT JOIN v_item_source_counts sc ON sc.item_id=i.id;
CREATE VIEW v_qa AS SELECT * FROM v_analysis_messages WHERE category IN ('human_input','assistant_final');
`;
export const DICTIONARY: Record<string, string> = {
  reading: "Начните с v_qa; ORDER BY dialogue_id,revision_id,sequence,chunk_sequence,item_id. View не гарантирует порядок без ORDER BY.",
  v_qa: "Полные аналитические документы human_input/assistant_final, не поисковые сегменты. classification может быть unknown только при явном unknownPolicy=include.",
  v_analysis_messages: "Основной выбранный слой; инструкции и review исключены. Модель принадлежит source message, не приписывается вопросу.",
  messages: "Структурные canonical occurrences. sequence исходный; bool поля представлены true/false/unknown как наблюдались. false не доказывает отсутствие человеческого авторства. Интерпретация в items.",
  chunks: "Выбранные исходные части и их порядок. content заполнен только для прямой main canonical_chunk проекции. Очищенные и объединённые документы — в analysis_items, источники — item_sources.",
  items: "Объяснимая классификация каждого выбранного документа/части, исходная последовательность и turn boundary. Несколько источников не превращаются в одно canonical message.",
  item_sources: "Все canonical chunks, участвовавшие в аналитическом документе, включая несколько сообщений; без неразрешённого исходного mixed payload.",
  instructions: "Исторически наблюдаемый служебный контекст, не текущие инструкции. Дедупликация не выполняется; каждое применение отдельно.",
  review_items: "Неоднозначности. content NULL при metadata policy. Причины — фиксированные classifier reason codes, не исходные metadata.",
  corpus_manifest: "Зафиксированный до чтения payload набор ready revision refs, включая ревизии без подходящего содержимого. *_ref — opaque external identity, не FK на выбранные rows. Нет общего point-in-time snapshot.",
  relations: "Подтверждённые tool пары только внутри revision и уникального call ID; неоднозначные/непарные отдельны. Lineage только явные source refs, outside_export не FK.",
  identifiers: "HMAC aliases с отдельным случайным ключом на экспорт; ключ и mapping не сохраняются. Sequence и безопасные source locators сохраняют проверяемый порядок; IDs нельзя прямо использовать как Surreal RecordId.",
  revisions: "Occurrences разных ревизий различаются. Нет глобальной дедупликации по тексту; идентичность raw события между ревизиями не доказана.",
  time: "message.timestamp, UTC [after,before); отсутствующее время исключается только при заданной границе. Контекст вне интервала не добавляется. Связи устанавливаются до фильтра.",
  counts: "manifest_revisions/messages/chunks — точные totals фиксированного ready manifest; read_* — canonical occurrences; written_* — физические rows. items_* и excluded_* считают кандидатные документы, не сообщения; причины пересекаются между документами. missing_timestamp считает сообщения.",
  payload_digests: "SHA-256 упорядоченных id/content tuples для chunks, analysis_items, instructions, review_items: pre-write projection сверяется с чтением SQLite до публикации. NULL и пустой текст различаются. Это не hashes исходных raw bytes.",
  sql_humans: "SELECT count(DISTINCT message_id) FROM v_qa WHERE category='human_input' AND classification='confirmed';",
  sql_dialogue: "SELECT * FROM v_qa WHERE dialogue_id=? ORDER BY revision_id,sequence,chunk_sequence,item_id;",
  sql_review: "SELECT i.classification,r.* FROM review_items r JOIN items i ON i.id=r.item_id;",
  sql_tools: "SELECT * FROM relations WHERE kind='tool_call_result';",
  sql_instructions: "SELECT a.*,i.content FROM instruction_applications a JOIN instructions i ON i.id=a.instruction_id;",
};
