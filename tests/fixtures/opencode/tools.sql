-- Golden fixture: диалог с tool calls, patch, subtask, file, model switch
-- (обезличенный, синтетический).

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
  'ses_demo002', 'proj_demo', null, '/Users/example/projects/demo-app',
  'Demo: refactor with tools', '1.18.4', 'build',
  '{"id":"gpt-5.6-sol","providerID":"openai"}',
  1784801000000, 1784801100000,
  11000, 700, 0, 6000, 0
);

insert into message values (
  'msg_u101', 'ses_demo002', 1784801001000,
  '{"role":"user","time":{"created":1784801001000},"agent":"build","model":{"providerID":"openai","modelID":"gpt-5.6-sol"}}'
);
insert into part values (
  'prt_u101a', 'msg_u101', 'ses_demo002', 1784801001000,
  '{"type":"text","text":"Refactor the parser and run the tests"}'
);

-- Первый assistant step: текст ДО tool activity + два tool call (один error).
insert into message values (
  'msg_a101', 'ses_demo002', 1784801002000,
  '{"role":"assistant","time":{"created":1784801002000,"completed":1784801030000},"parentID":"msg_u101","modelID":"gpt-5.6-sol","providerID":"openai","mode":"build","agent":"build","cost":0.01,"tokens":{"total":5000,"input":3000,"output":200,"reasoning":0,"cache":{"read":2000,"write":0}},"finish":"tool-calls"}'
);
insert into part values ('prt_a101s', 'msg_a101', 'ses_demo002', 1784801002000, '{"type":"step-start"}');
insert into part values (
  'prt_a101a', 'msg_a101', 'ses_demo002', 1784801003000,
  '{"type":"text","text":"I will read the parser first, then run the tests."}'
);
insert into part values (
  'prt_a101b', 'msg_a101', 'ses_demo002', 1784801004000,
  '{"type":"tool","callID":"call_001","tool":"read","state":{"status":"completed","input":{"filePath":"src/parser.ts"},"output":"export function parse() {}","time":{"start":1784801004000,"end":1784801005000}}}'
);
insert into part values (
  'prt_a101c', 'msg_a101', 'ses_demo002', 1784801006000,
  '{"type":"tool","callID":"call_002","tool":"bash","state":{"status":"error","input":{"command":"bun test"},"error":"2 tests failed","time":{"start":1784801006000,"end":1784801020000}}}'
);
insert into part values (
  'prt_a101f', 'msg_a101', 'ses_demo002', 1784801030000,
  '{"type":"step-finish","reason":"tool-calls","snapshot":"deadbeef1234","cost":0.01,"tokens":{"total":5000,"input":3000,"output":200,"reasoning":0,"cache":{"read":2000,"write":0}}}'
);
insert into part values (
  'prt_a101p', 'msg_a101', 'ses_demo002', 1784801031000,
  '{"type":"patch","hash":"deadbeef1234","files":["/Users/example/projects/demo-app/src/parser.ts"]}'
);

-- Второй assistant step: другая модель (model switch), текст ПОСЛЕ tool
-- activity, subtask и file-вложение.
insert into message values (
  'msg_a102', 'ses_demo002', 1784801040000,
  '{"role":"assistant","time":{"created":1784801040000,"completed":1784801090000},"parentID":"msg_u101","modelID":"kimi-k2","providerID":"openrouter","mode":"build","agent":"build","cost":0.02,"tokens":{"total":9000,"input":8000,"output":500,"reasoning":0,"cache":{"read":4000,"write":0}},"finish":"stop"}'
);
insert into part values ('prt_a102s', 'msg_a102', 'ses_demo002', 1784801040000, '{"type":"step-start"}');
insert into part values (
  'prt_a102a', 'msg_a102', 'ses_demo002', 1784801050000,
  '{"type":"text","text":"Fixed the failing tests. Here is a summary of the changes."}'
);
insert into part values (
  'prt_a102b', 'msg_a102', 'ses_demo002', 1784801060000,
  '{"type":"subtask","prompt":"Review the diff in src/parser.ts","description":"code review","agent":"reviewer","model":{"providerID":"openrouter","modelID":"kimi-k2"}}'
);
insert into part values (
  'prt_a102c', 'msg_a102', 'ses_demo002', 1784801070000,
  '{"type":"file","mime":"text/plain","filename":"notes.txt","url":"file:///Users/example/notes.txt","source":{"text":{"value":"@notes.txt","start":1,"end":5},"type":"file","path":"/Users/example/notes.txt"}}'
);
insert into part values (
  'prt_a102f', 'msg_a102', 'ses_demo002', 1784801090000,
  '{"type":"step-finish","reason":"stop","snapshot":"deadbeef5678","cost":0.02,"tokens":{"total":9000,"input":8000,"output":500,"reasoning":0,"cache":{"read":4000,"write":0}}}'
);
