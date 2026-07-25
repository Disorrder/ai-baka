-- Golden fixture: два turn'а, второй промпт через SDK с structured-output
-- format → humanAuthored "unknown", но это граница turn'а (§8.2): финальный
-- ответ — только после последнего промпта (обезличенный, синтетический).

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
  'ses_demo006', 'proj_demo', null, '/Users/example/projects/demo-app',
  'Demo: unknown prompt as turn boundary', '1.18.4', 'build',
  '{"id":"gpt-5.6-sol","providerID":"openai"}',
  1784805000000, 1784805100000,
  0, 0, 0, 0, 0
);

-- Turn 1: обычный промпт человека.
insert into message values (
  'msg_u401', 'ses_demo006', 1784805001000,
  '{"role":"user","time":{"created":1784805001000},"agent":"build"}'
);
insert into part values (
  'prt_u401a', 'msg_u401', 'ses_demo006', 1784805001000,
  '{"type":"text","text":"First question: what does parseConfig do?"}'
);
insert into message values (
  'msg_a401', 'ses_demo006', 1784805002000,
  '{"role":"assistant","time":{"created":1784805002000,"completed":1784805030000},"parentID":"msg_u401","modelID":"gpt-5.6-sol","providerID":"openai","agent":"build","cost":0.01,"tokens":{"total":2000,"input":1500,"output":500,"reasoning":0,"cache":{"read":0,"write":0}},"finish":"stop"}'
);
insert into part values (
  'prt_a401a', 'msg_a401', 'ses_demo006', 1784805002100,
  '{"type":"text","text":"Answer to the first question: parseConfig reads TOML."}'
);

-- Turn 2: промпт через SDK (format) → humanAuthored "unknown".
insert into message values (
  'msg_u402', 'ses_demo006', 1784805040000,
  '{"role":"user","time":{"created":1784805040000},"agent":"build","format":{"type":"json_schema","schema":{"type":"object","properties":{"ok":{"type":"boolean"}}}}}'
);
insert into part values (
  'prt_u402a', 'msg_u402', 'ses_demo006', 1784805040000,
  '{"type":"text","text":"Second question sent via SDK"}'
);
insert into message values (
  'msg_a402', 'ses_demo006', 1784805045000,
  '{"role":"assistant","time":{"created":1784805045000,"completed":1784805090000},"parentID":"msg_u402","modelID":"gpt-5.6-sol","providerID":"openai","agent":"build","cost":0.01,"tokens":{"total":2100,"input":1600,"output":500,"reasoning":0,"cache":{"read":0,"write":0}},"finish":"stop"}'
);
insert into part values (
  'prt_a402a', 'msg_a402', 'ses_demo006', 1784805046000,
  '{"type":"text","text":"Answer to the second question."}'
);
