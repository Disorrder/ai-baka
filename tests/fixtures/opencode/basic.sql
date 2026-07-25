-- Golden fixture: обычный диалог opencode (обезличенный, синтетический).
-- Схема — минимальное подмножество живой opencode.db (1.18.x).

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
  'ses_demo001', 'proj_demo', null, '/Users/example/projects/demo-app',
  'Demo: cache explanation', '1.18.4', 'build',
  '{"id":"qwen3.8-max-preview","providerID":"aliyun-token-plan"}',
  1784800000000, 1784800060000,
  2000, 150, 40, 3000, 500
);

insert into message values (
  'msg_u001', 'ses_demo001', 1784800001000,
  '{"role":"user","time":{"created":1784800001000},"agent":"build","model":{"providerID":"aliyun-token-plan","modelID":"qwen3.8-max-preview"}}'
);
insert into part values (
  'prt_u001a', 'msg_u001', 'ses_demo001', 1784800001000,
  '{"type":"text","text":"Explain how the cache works in src/cache.ts"}'
);

insert into message values (
  'msg_a001', 'ses_demo001', 1784800002000,
  '{"role":"assistant","time":{"created":1784800002000,"completed":1784800009000},"parentID":"msg_u001","modelID":"qwen3.8-max-preview","providerID":"aliyun-token-plan","mode":"build","agent":"build","path":{"cwd":"/Users/example/projects/demo-app","root":"/Users/example/projects/demo-app"},"cost":0.002,"tokens":{"total":5690,"input":2000,"output":150,"reasoning":40,"cache":{"read":3000,"write":500}},"finish":"stop"}'
);
insert into part values (
  'prt_a001a', 'msg_a001', 'ses_demo001', 1784800002100,
  '{"type":"reasoning","text":"Let me recall the cache module structure first.","time":{"start":1784800002100,"end":1784800004000}}'
);
insert into part values (
  'prt_a001b', 'msg_a001', 'ses_demo001', 1784800005000,
  '{"type":"text","text":"The cache in src/cache.ts is a simple LRU with TTL."}'
);
