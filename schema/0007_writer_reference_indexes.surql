-- 0007_writer_reference_indexes.surql
-- Индексы для горячего пути writer'а: публикация новой current revision
-- удаляет старую search projection по dialogue_revision и связанные jobs
-- по search_document. Без этих индексов live sync делает полный скан
-- search_document/embedding_job в финальной транзакции диалога.

DEFINE INDEX IF NOT EXISTS search_document_dialogue_revision ON TABLE search_document FIELDS dialogue_revision;
DEFINE INDEX IF NOT EXISTS embedding_job_search_document ON TABLE embedding_job FIELDS search_document;
