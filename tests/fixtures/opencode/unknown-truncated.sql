-- Golden fixture: неизвестные события, corrupted/truncated данные, пустые
-- сообщения (обезличенный, синтетический). План §11.2, сценарий 11.

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

-- Сессия без project_id: workspace только из session.directory.
insert into session values (
  'ses_demo003', null, null, '/Users/example', 'Demo: weird events',
  '1.2.24', 'build', null,
  1784802000000, 1784802060000,
  0, 0, 0, 0, 0
);

-- Пустая сессия без сообщений.
insert into session values (
  'ses_demo004', null, null, '/Users/example', 'Demo: empty session',
  '1.2.24', 'build', null,
  1784803000000, 1784803000000,
  0, 0, 0, 0, 0
);

-- Corrupted message data (truncated JSON).
insert into message values (
  'msg_u201', 'ses_demo003', 1784802001000,
  '{"role":"user","time":{"created":178480200100'
);

-- Assistant message: неизвестный part type (дважды — diagnostic один раз),
-- пустой text part, corrupted part data.
insert into message values (
  'msg_a201', 'ses_demo003', 1784802002000,
  '{"role":"assistant","time":{"created":1784802002000,"completed":1784802050000},"parentID":"msg_u201","modelID":"gpt-5.6-sol","providerID":"openai","agent":"build","cost":0,"tokens":{"total":0,"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"finish":"stop"}'
);
insert into part values (
  'prt_a201w', 'msg_a201', 'ses_demo003', 1784802002100,
  '{"type":"widget","payload":{"foo":1}}'
);
insert into part values (
  'prt_a201e', 'msg_a201', 'ses_demo003', 1784802002200,
  '{"type":"text","text":""}'
);
insert into part values (
  'prt_a201x', 'msg_a201', 'ses_demo003', 1784802002300,
  '["broken part"'
);
insert into part values (
  'prt_a201w2', 'msg_a201', 'ses_demo003', 1784802002400,
  '{"type":"widget","payload":{"foo":2}}'
);
insert into part values (
  'prt_a201t', 'msg_a201', 'ses_demo003', 1784802002500,
  '{"type":"text","text":"Partial answer survives."}'
);

-- Сообщение вообще без parts (пустое сообщение).
insert into message values (
  'msg_a202', 'ses_demo003', 1784802003000,
  '{"role":"assistant","time":{"created":1784802003000},"parentID":"msg_u201","modelID":"gpt-5.6-sol","providerID":"openai","agent":"build","cost":0,"tokens":{"total":0,"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"error":{"name":"APIError","data":{"message":"model overloaded","statusCode":503}}}'
);
