import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PayloadVerifier } from "../src/sqlite-export/payload-verification.ts";

function database() {
  const db=new Database(":memory:");
  db.exec("CREATE TABLE chunks(id TEXT,content TEXT); CREATE TABLE analysis_items(item_id TEXT,content TEXT); CREATE TABLE instructions(id TEXT,content TEXT); CREATE TABLE review_items(item_id TEXT,content TEXT)");
  return db;
}

test("payload readback preserves NUL, Unicode, empty strings and NULL",()=>{
  const db=database(),verifier=new PayloadVerifier();
  try {
    for(const [id,content] of [["nul","a\0b 東京 😀"],["empty",""],["null",null]] as const) {
      verifier.record("analysis_items",[id,content]);
      db.prepare("INSERT INTO analysis_items VALUES(?,?)").run(id,content);
    }
    const verified=verifier.verify(db);
    expect(verified.analysis_items!.rows).toBe(3);
    expect(db.query("SELECT content FROM analysis_items WHERE item_id='nul'").get()).toEqual({content:"a\0b 東京 😀"});
  } finally {db.close();}
});

test("payload verification rejects changed text despite unchanged row counts",()=>{
  const db=database(),verifier=new PayloadVerifier();
  try {
    verifier.record("analysis_items",["a","original"]);
    db.exec("INSERT INTO analysis_items VALUES('a','modified')");
    expect(()=>verifier.verify(db)).toThrow("payload verification failed");
  } finally {db.close();}
});

test("NULL cannot silently become empty text",()=>{
  const db=database(),verifier=new PayloadVerifier();
  try {
    verifier.record("review_items",["a","unknown",null]);
    db.exec("INSERT INTO review_items VALUES('a','')");
    expect(()=>verifier.verify(db)).toThrow("payload verification failed");
  } finally {db.close();}
});
