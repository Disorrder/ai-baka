import { beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { createCommandTokenCounter } from "../src/embeddings/token-count.ts";

const SCRIPT = path.resolve(import.meta.dir, "../scripts/exact-tokenizer.py");
const MODEL = "text-embedding-3-large";
const KNOWN_TEXTS = [
  "",
  "hello world",
  "Привет, мир!",
  "👩‍💻 café\n第二行",
  "<|endoftext|>",
];
// tiktoken==0.13.0, encoding_for_model("text-embedding-3-large") → cl100k_base.
const KNOWN_COUNTS = [0, 2, 7, 12, 7];

interface Invocation {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function invoke(
  stdin: string | Uint8Array | undefined,
  options: { args?: string[]; offline?: boolean } = {},
): Promise<Invocation> {
  const child = Bun.spawn({
    cmd: [
      "uv",
      "run",
      "--quiet",
      ...(options.offline ?? true ? ["--offline"] : []),
      "--script",
      SCRIPT,
      ...(options.args ?? []),
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined) child.stdin.write(stdin);
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

let warmInvocation: Invocation;

beforeAll(async () => {
  // First run is intentionally allowed to populate uv + tiktoken caches.
  // Every focused assertion below uses uv --offline.
  warmInvocation = await invoke(JSON.stringify({ model: MODEL, texts: KNOWN_TEXTS }), {
    offline: false,
  });
  if (warmInvocation.exitCode !== 0) {
    throw new Error(`exact-tokenizer warm-up failed (stderr bytes=${warmInvocation.stderr.length})`);
  }
});

describe("exact-tokenizer trusted JSON protocol", () => {
  test("returns known tiktoken 0.13.0 counts for empty/Unicode/special-looking text", () => {
    expect(warmInvocation.stderr).toBe("");
    expect(warmInvocation.stdout.endsWith("\n")).toBe(true);
    const response = JSON.parse(warmInvocation.stdout) as { counts: number[] };
    expect(Object.keys(response)).toEqual(["counts"]);
    expect(response.counts).toEqual(KNOWN_COUNTS);
  });

  test("supports empty and multi-item batches offline", async () => {
    const empty = await invoke(JSON.stringify({ model: MODEL, texts: [] }));
    expect(empty).toEqual({ exitCode: 0, stdout: '{"counts":[]}\n', stderr: "" });

    const batch = await invoke(
      JSON.stringify({ model: MODEL, texts: ["one", "two words", "три"] }),
    );
    expect(batch.exitCode).toBe(0);
    expect(batch.stderr).toBe("");
    expect(JSON.parse(batch.stdout)).toEqual({ counts: [1, 2, 2] });
  });

  test("stable --version seam identifies the exact implementation", async () => {
    const result = await invoke(undefined, { args: ["--version"] });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      id: "ai-baka-exact-tokenizer",
      protocolVersion: 1,
      scriptVersion: 1,
      package: { name: "tiktoken", version: "0.13.0" },
      resolver: "encoding_for_model",
    });
  });

  test("is directly consumable by createCommandTokenCounter", async () => {
    const counter = createCommandTokenCounter({
      executable: "uv",
      args: ["run", "--quiet", "--offline", "--script", SCRIPT],
      id: "ai-baka-exact-tokenizer/1+tiktoken@0.13.0",
      model: MODEL,
      requireOffline: true,
    });
    await expect(counter.countBatch(["hello world", "Привет, мир!"])).resolves.toEqual([2, 7]);
  });

  test("rejects malformed input with stable non-content errors", async () => {
    const cases: Array<[string | Uint8Array, string]> = [
      ["", "empty-input"],
      ["not json", "invalid-json"],
      [`{"model":"${MODEL}","texts":[NaN]}`, "invalid-json"],
      ['{"model":"x","model":"y","texts":[]}', "duplicate-key"],
      [JSON.stringify({ model: MODEL }), "invalid-fields"],
      [JSON.stringify({ model: MODEL, texts: [], extra: true }), "invalid-fields"],
      [JSON.stringify({ model: MODEL, texts: "secret-content" }), "texts-not-array"],
      [JSON.stringify({ model: MODEL, texts: ["ok", 1] }), "text-not-string"],
      [new Uint8Array([0xff, 0xfe]), "invalid-utf8"],
    ];
    for (const [input, code] of cases) {
      const result = await invoke(input);
      expect(result.exitCode, code).toBe(65);
      expect(result.stdout, code).toBe("");
      expect(result.stderr, code).toBe(`ai-baka-exact-tokenizer:error:${code}\n`);
      expect(result.stderr).not.toContain("secret-content");
    }
  });

  test("unknown model fails closed without heuristic fallback or content logs", async () => {
    const result = await invoke(
      JSON.stringify({ model: "definitely-unknown-model", texts: ["PRIVATE-CONTENT"] }),
    );
    expect(result.exitCode).toBe(65);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("ai-baka-exact-tokenizer:error:unknown-model\n");
    expect(result.stderr).not.toContain("definitely-unknown-model");
    expect(result.stderr).not.toContain("PRIVATE-CONTENT");
  });

  test("enforces the command adapter batch maximum", async () => {
    const result = await invoke(
      JSON.stringify({ model: MODEL, texts: Array.from({ length: 1001 }, () => "") }),
    );
    expect(result.exitCode).toBe(65);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("ai-baka-exact-tokenizer:error:batch-too-large\n");
  });
});
