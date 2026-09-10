type Selection = { readonly [field: string]: true | "presence" | Selection };
const USAGE: Selection = {inputTokens:true,cachedInputTokens:true,cacheWriteInputTokens:true,outputTokens:true,reasoningOutputTokens:true,totalTokensReported:true,totalTokensNormalized:true};
const METADATA: Selection = {userMessageText:true,confirmedBy:true,phase:true,originKind:true,origin:{kind:true},isMeta:true,sidechain:true,parentToolUseId:true,subagentId:true,turnResult:"presence",finish:true,subtype:true,autoContext:true};
const FIELDS: Record<string,Selection> = {
  message: {id:true,dialogue_revision:true,sequence:true,role:true,raw_role:true,human_authored:true,visible_to_user:true,timestamp:true,model:true,raw_model_name:true,reasoning_effort:true,service_provider:true,response_status:true,response_turn_id:true,response_wait_ms:true,response_completed_at:true,usage:USAGE,metadata:METADATA},
  chunk: {id:true,dialogue_revision:true,message:true,sequence:true,kind:true,raw_kind:true,content:true,content_bytes:true,content_sha256:true,source_locator:true,tool_call_id:true,tool_name:true,raw_event_type:true,metadata:METADATA},
  model: {id:true,vendor:true,canonical_name:true},
  vendor: {id:true,slug:true},
};
export const STREAM_TABLES = ["chunk","message","model","vendor"] as const;
export type StreamTable = typeof STREAM_TABLES[number];
export interface StreamRecord { table: StreamTable; value: Record<string,unknown> }

const ESCAPES:Record<string,string>={n:"\n",r:"\r",t:"\t",b:"\b",f:"\f",v:"\v","0":"\0","\\":"\\","'":"'",'"':'"',"`":"`","⟩":"⟩","/":"/"};
function stringEnd(text:string,start:number):number {
  const close=text[start]==="⟨"?"⟩":text[start]!;
  let end=text.indexOf(close,start+1);
  while(end>=0) {
    let before=end-1;
    while(before>start&&text[before]==="\\")before--;
    if((end-1-before)%2===1){end=text.indexOf(close,end+1);continue;}
    if(text[end+1]===close){end=text.indexOf(close,end+2);continue;}
    return end+1;
  }
  throw new Error("sqlite export: unterminated string");
}

const STRING_ESCAPES=/\\(?:u\{[^}]*\}|u[\s\S]{4}|x[\s\S]{2}|[\s\S])|''|""|``|⟩⟩/g;
function quoted(text: string, start: number): {value:string;end:number} {
  const end=stringEnd(text,start),close=text[start]==="⟨"?"⟩":text[start]!;
  const value=text.slice(start+1,end-1).replace(STRING_ESCAPES,escape=>{
    if(escape[0]!=="\\")return escape[0]===close?close:escape;
    const e=escape[1]!;
    if(e==="u"||e==="x") {
      const braced=escape.startsWith("\\u{");
      const digits=braced?escape.slice(3,-1):escape.slice(2);
      if(!/^[0-9a-fA-F]{1,6}$/.test(digits)||!braced&&digits.length!==(e==="u"?4:2))throw new Error("sqlite export: malformed Unicode escape");
      const code=Number.parseInt(digits,16);
      if(code>0x10ffff)throw new Error("sqlite export: invalid Unicode code point");
      return String.fromCodePoint(code);
    }
    if(!Object.hasOwn(ESCAPES,e))throw new Error("sqlite export: unsupported string escape");
    return ESCAPES[e]!;
  });
  return {value,end};
}

/** Locate a literal boundary, never evaluate SurrealQL or interpret historical text as code. */
function valueEnd(text:string,start:number):number {
  const stack:string[]=[];
  for(let i=start;i<text.length;i++) {
    const c=text[i]!;
    if(c==="'"||c==='"'||c==="`"||c==="⟨") {i=stringEnd(text,i)-1;continue;}
    if(c==="{"||c==="["||c==="("){stack.push(c==="{"?"}":c==="["?"]":")");if(stack.length>256)throw new Error("sqlite export: source nesting limit exceeded");}
    else if(c==="}"||c==="]"||c===")") {if(!stack.length)return i;if(stack.pop()!==c)throw new Error("sqlite export: unbalanced source literal");}
    else if(c===","&&!stack.length)return i;
  }
  return text.length;
}
function scalar(raw:string):unknown {
  const text=raw.trim();
  if(text==="NONE")return undefined;
  if(text==="NULL"||text==="null")return null;
  if(text==="true"||text==="false")return text==="true";
  if(text[0]==="'"||text[0]==='"')return quoted(text,0).value;
  if(/^d['"]/.test(text))return quoted(text,1).value;
  if(/^[A-Za-z_][A-Za-z0-9_]*:/.test(text))return text;
  if(/^[+-]?\d+$/.test(text)){const n=Number(text);return Number.isSafeInteger(n)?n:BigInt(text);}
  if(/^[+-]?(?:\d+\.\d*|\d*\.\d+|\d+)(?:[eE][+-]?\d+)?f?$/.test(text)){const n=Number(text.replace(/f$/,""));if(Number.isFinite(n))return n;}
  // Selected scalar fields with unsupported source types stay unavailable.
  return undefined;
}
function selectedObject(text:string,selection:Selection):Record<string,unknown> {
  const result:Record<string,unknown>=Object.create(null);
  let i=1;
  while(i<text.length) {
    while(/\s|,/.test(text[i]??"")&&i<text.length)i++;
    if(text[i]==="}")return result;
    let key:string;
    if(["'",'"',"`","⟨"].includes(text[i]??"")){const q=quoted(text,i);key=q.value;i=q.end;}
    else {const start=i;while(i<text.length&&/[A-Za-z0-9_]/.test(text[i]!))i++;key=text.slice(start,i);if(!key)throw new Error("sqlite export: malformed object key");}
    while(/\s/.test(text[i]??"")&&i<text.length)i++;
    if(text[i++]!==":")throw new Error("sqlite export: malformed object field");
    const start=i,end=valueEnd(text,start);i=end;
    if(!Object.hasOwn(selection,key))continue;
    const rule=selection[key]!,raw=text.slice(start,end).trim();
    const value=rule==="presence"?(raw==="NONE"?undefined:true):rule===true?scalar(raw):raw.startsWith("{")?selectedObject(raw,rule):undefined;
    if(value!==undefined)result[key]=value;
  }
  throw new Error("sqlite export: incomplete source object");
}

/** Native /export emits one INSERT array per batch. Retain only one record, not the array. */
export async function* streamExportRecords(input: AsyncIterable<Uint8Array>, maxRecordBytes: number): AsyncGenerator<StreamRecord> {
  const decoder=new TextDecoder("utf-8",{fatal:true});
  let mode:"head"|"skip"|"insert"|"semicolon"="head",head="",table:StreamTable|undefined;
  let quote:string|undefined,escaped=false,stack:string[]=[];
  let parts:string[]=[],bytes=0,between:"record"|"separator"="record";
  const seen=new Set<string>();
  const consume=function*(text:string):Generator<StreamRecord>{
    let span=stack.length?0:-1;
    for(let i=0;i<text.length;i++) {
      const c=text[i]!;
      if(mode==="skip"){if(c==="\n"){mode="head";head="";}continue;}
      if(mode==="head") {
        if(c==="\n") {
          if(head.startsWith("-- TABLE DATA: ")) {const name=head.slice(15).trim();if(!STREAM_TABLES.includes(name as StreamTable))throw new Error("sqlite export: unexpected source table");table=name as StreamTable;seen.add(name);}
          else if(head.startsWith("-- TABLE: "))table=undefined;
          head="";continue;
        }
        head+=c;
        if(head==="INSERT [") {if(!table)throw new Error("sqlite export: record outside data section");mode="insert";head="";between="record";continue;}
        if(head.length>128){head="";mode="skip";}
        continue;
      }
      if(mode==="semicolon") {if(/\s/.test(c))continue;if(c!==";")throw new Error("sqlite export: malformed INSERT termination");mode="skip";continue;}
      if(!stack.length) {
        if(/\s/.test(c))continue;
        if(c==="]"){mode="semicolon";continue;}
        if(between==="separator"){if(c!==",")throw new Error("sqlite export: malformed record separation");between="record";continue;}
        if(c!=="{")throw new Error("sqlite export: expected record object");
        span=i;stack.push("}");continue;
      }
      if(quote) {
        if(escaped){escaped=false;continue;}
        const end=text.indexOf(quote,i);
        if(end<0) {
          let before=text.length-1;
          while(before>=i&&text[before]==="\\")before--;
          escaped=(text.length-1-before)%2===1;
          break;
        }
        let before=end-1;
        while(before>=i&&text[before]==="\\")before--;
        if((end-1-before)%2===0)quote=undefined;
        i=end;continue;
      }
      if(c==="'"||c==='"'||c==="`"||c==="⟨"){quote=c==="⟨"?"⟩":c;continue;}
      if(c==="{"||c==="["||c==="("){stack.push(c==="{"?"}":c==="["?"]":")");if(stack.length>256)throw new Error("sqlite export: source nesting limit exceeded");}
      else if(c==="}"||c==="]"||c===")") {
        if(stack.pop()!==c)throw new Error("sqlite export: unbalanced source record");
        if(!stack.length) {
          const fragment=text.slice(span,i+1);bytes+=Buffer.byteLength(fragment);if(bytes>maxRecordBytes)throw new Error("sqlite export: source record exceeds maxRevisionBytes");parts.push(fragment);
          const value=selectedObject(parts.join(""),FIELDS[table!]!);parts=[];bytes=0;span=-1;between="separator";
          if(typeof value.id!=="string"||!value.id.startsWith(`${table}:`))throw new Error("sqlite export: source record identity mismatch");
          yield {table:table!,value};
        }
      }
    }
    if(span>=0){const fragment=text.slice(span);bytes+=Buffer.byteLength(fragment);if(bytes>maxRecordBytes)throw new Error("sqlite export: source record exceeds maxRevisionBytes");parts.push(fragment);}
  };
  for await(const chunk of input)yield* consume(decoder.decode(chunk,{stream:true}));
  yield* consume(decoder.decode());
  if(stack.length||!["head","skip"].includes(mode)||quote)throw new Error("sqlite export: truncated source stream");
  for(const name of STREAM_TABLES)if(!seen.has(name))throw new Error("sqlite export: incomplete source export tables");
}
