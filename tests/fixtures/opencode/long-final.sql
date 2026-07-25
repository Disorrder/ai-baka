-- Golden fixture: длинный финальный ответ из нескольких text chunks в
-- нескольких assistant messages (сценарий 20), user message с
-- structured-output format (SDK) (обезличенный, синтетический).

create table project (id text, worktree text, vcs text, name text);
create table session (
  id text, project_id text, parent_id text, directory text, title text,
  version text, agent text, model text,
  time_created integer, time_updated integer,
  tokens_input integer, tokens_output integer, tokens_reasoning integer,
  tokens_cache_read integer, tokens_cache_write integer
);
create table message (id text, session_id text, time_created integer, data text);
create table part (id text, message_id text, session_id text, time_created integer, data text);

insert into project values ('proj_demo', '/Users/example/projects/demo-app', 'git', null);

insert into session values (
  'ses_demo005', 'proj_demo', null, '/Users/example/projects/demo-app',
  'Demo: long final answer', '1.18.4', 'build',
  '{"id":"gpt-5.6-sol","providerID":"openai"}',
  1784804000000, 1784804100000,
  4000, 900, 0, 1000, 0
);

-- Промпт через SDK с structured output → humanAuthored "unknown".
insert into message values (
  'msg_u301', 'ses_demo005', 1784804001000,
  '{"role":"user","time":{"created":1784804001000},"agent":"build","format":{"type":"json_schema","schema":{"type":"object","properties":{"ok":{"type":"boolean"}}}}}'
);
insert into part values (
  'prt_u301a', 'msg_u301', 'ses_demo005', 1784804001000,
  '{"type":"text","text":"Summarize the release in three paragraphs"}'
);

-- Turn 1: текст + tool activity (finish tool-calls).
insert into message values (
  'msg_a301', 'ses_demo005', 1784804002000,
  '{"role":"assistant","time":{"created":1784804002000,"completed":1784804030000},"parentID":"msg_u301","modelID":"gpt-5.6-sol","providerID":"openai","agent":"build","cost":0.01,"tokens":{"total":2500,"input":2000,"output":300,"reasoning":0,"cache":{"read":1000,"write":0}},"finish":"tool-calls"}'
);
insert into part values (
  'prt_a301a', 'msg_a301', 'ses_demo005', 1784804002100,
  '{"type":"text","text":"First paragraph: the release adds incremental sync."}'
);
insert into part values (
  'prt_a301b', 'msg_a301', 'ses_demo005', 1784804002200,
  '{"type":"tool","callID":"call_301","tool":"read","state":{"status":"completed","input":{"filePath":"CHANGELOG.md"},"output":"## 1.0.0 - incremental sync"}}'
);

-- Turn 2: два text-чанка (finish stop).
insert into message values (
  'msg_a302', 'ses_demo005', 1784804040000,
  '{"role":"assistant","time":{"created":1784804040000,"completed":1784804090000},"parentID":"msg_u301","modelID":"gpt-5.6-sol","providerID":"openai","agent":"build","cost":0.01,"tokens":{"total":3500,"input":2000,"output":600,"reasoning":0,"cache":{"read":0,"write":0}},"finish":"stop"}'
);
insert into part values (
  'prt_a302a', 'msg_a302', 'ses_demo005', 1784804041000,
  '{"type":"text","text":"Second paragraph: migration tooling was rewritten."}'
);
insert into part values (
  'prt_a302b', 'msg_a302', 'ses_demo005', 1784804042000,
  '{"type":"text","text":"Third paragraph: known limitations are documented."}'
);
