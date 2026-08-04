-- 0008_response_timing.surql
-- Cached response wait timings for analytics. These are parsed from harness
-- turn/task telemetry and stored on the human user message, because aborted or
-- cancelled turns can have no assistant message to attach timing to.

DEFINE FIELD IF NOT EXISTS response_wait_ms ON TABLE message TYPE option<int>;
-- completed | aborted | incomplete
DEFINE FIELD IF NOT EXISTS response_status ON TABLE message TYPE option<string>;
DEFINE FIELD IF NOT EXISTS response_completed_at ON TABLE message TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS response_turn_id ON TABLE message TYPE option<string>;
