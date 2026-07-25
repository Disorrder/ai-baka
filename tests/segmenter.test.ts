/**
 * Unit-тесты segmenter'а (docs/plan.md §13.4): границы разбиения, code
 * fences целиком, лимиты (target 6000–7000, hard < 8192 через эвристику
 * chars/3.5), детерминизм, seam counter'а.
 */

import { describe, expect, test } from "bun:test";
import {
  CHARS_PER_TOKEN,
  MAX_TOKENS,
  TARGET_TOKENS,
  heuristicTokenCounter,
  segmentDocument,
} from "../src/search/segmenter.ts";

const counter = heuristicTokenCounter;
const chars = (tokens: number): number => Math.floor(tokens * CHARS_PER_TOKEN);

/** Абзац заданного размера в токенах. */
function paragraph(tokens: number, fill = "а"): string {
  return fill.repeat(chars(tokens));
}

describe("segmentDocument", () => {
  test("короткий документ — один сегмент без изменений", () => {
    const content = "короткий ответ ассистента";
    const segments = segmentDocument(content);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.content).toBe(content);
    expect(segments[0]!.tokenCount).toBe(counter(content));
  });

  test("пустой и whitespace-only документ — один сегмент", () => {
    expect(segmentDocument("")).toHaveLength(1);
    expect(segmentDocument("\n\n  \n")).toHaveLength(1);
  });

  test("документ ровно на границе target — один сегмент", () => {
    const content = paragraph(TARGET_TOKENS);
    expect(segmentDocument(content)).toHaveLength(1);
    // Один блок больше target, но в пределах MAX — тоже один сегмент
    // (мягкий target: резать негде, жёсткий предел не превышен).
    expect(segmentDocument(paragraph(TARGET_TOKENS + 100))).toHaveLength(1);
    // Блок больше MAX — режется.
    expect(segmentDocument(paragraph(MAX_TOKENS + 500)).length).toBeGreaterThan(1);
  });

  test("длинный документ: все сегменты ≤ MAX, блоки покрыты в порядке", () => {
    const blocks = Array.from({ length: 10 }, (_, i) => `Абзац ${i}. ${paragraph(2000)}`);
    const segments = segmentDocument(blocks.join("\n\n"));
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.tokenCount).toBeLessThanOrEqual(MAX_TOKENS);
      expect(segment.tokenCount).toBe(counter(segment.content));
    }
    const joined = segments.map((s) => s.content).join("\n\n");
    for (const block of blocks) expect(joined).toContain(block);
    // порядок блоков сохранён
    const positions = blocks.map((b) => joined.indexOf(b));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test("code fence не рвётся, если помещается в лимит", () => {
    const fence = "```ts\n" + "const x = 1;\n".repeat(500) + "```";
    const content = [paragraph(4000, "в"), fence, paragraph(4000, "г")].join("\n\n");
    const segments = segmentDocument(content);
    expect(segments.length).toBeGreaterThan(1);
    // fence целиком внутри ровно одного сегмента
    const containing = segments.filter((s) => s.content.includes("const x = 1;"));
    expect(containing).toHaveLength(1);
    expect(containing[0]!.content).toContain(fence);
  });

  test("разрыв предпочтительно на heading: сегмент начинается с заголовка", () => {
    const content = [
      `${paragraph(3000, "а")}`,
      "## Раздел два",
      `${paragraph(3000, "б")}`,
      `${paragraph(3000, "в")}`,
    ].join("\n\n");
    const segments = segmentDocument(content);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    // heading попал в начало нового сегмента, а не в конец предыдущего
    expect(segments[0]!.content.endsWith("## Раздел два")).toBe(false);
    expect(segments.some((s) => s.content.startsWith("## Раздел два"))).toBe(true);
  });

  test("oversized fence режется по строкам с перевёрнутыми маркерами", () => {
    const fence = "```python\n" + "x = 1\n".repeat(40000) + "```"; // ~240k chars >> MAX
    const segments = segmentDocument(fence);
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.tokenCount).toBeLessThanOrEqual(MAX_TOKENS);
      expect(segment.content.startsWith("```python\n")).toBe(true);
      expect(segment.content.endsWith("\n```")).toBe(true);
    }
    // содержимое не потеряно
    const lines = segments.flatMap((s) => s.content.split("\n")).filter((l) => l === "x = 1");
    expect(lines).toHaveLength(40000);
  });

  test("экстремально длинная строка — посимвольный split в пределах MAX", () => {
    const content = "ж".repeat(chars(MAX_TOKENS) * 3); // одна строка, 3×MAX
    const segments = segmentDocument(content);
    expect(segments.length).toBeGreaterThanOrEqual(3);
    for (const segment of segments) {
      expect(segment.tokenCount).toBeLessThanOrEqual(MAX_TOKENS);
    }
    expect(segments.map((s) => s.content).join("\n\n").replaceAll("\n", "")).toBe(content);
  });

  test("незакрытый fence — до конца документа, лимит соблюдён", () => {
    const content = "intro\n\n```ts\n" + "let a = 0;\n".repeat(30000);
    const segments = segmentDocument(content);
    for (const segment of segments) {
      expect(segment.tokenCount).toBeLessThanOrEqual(MAX_TOKENS);
    }
  });

  test("детерминизм: одинаковый вход → одинаковый выход", () => {
    const content = Array.from({ length: 20 }, (_, i) => `## S${i}\n${paragraph(1000)}`).join("\n\n");
    expect(segmentDocument(content)).toEqual(segmentDocument(content));
  });

  test("seam: внешний counter управляет разбиением", () => {
    // counter, считающий всё «очень дорогим»: даже короткий текст режется
    const expensive = (text: string): number => text.length * 10000;
    const content = ["aaaa", "bbbb", "cccc"].join("\n\n");
    const segments = segmentDocument(content, expensive);
    expect(segments.length).toBe(3);
    for (const segment of segments) {
      expect(segment.tokenCount).toBe(expensive(segment.content));
    }
    // точный counter этапа 7: всё в один сегмент
    const cheap = (text: string): number => Math.ceil(text.length / 1000);
    expect(segmentDocument(content, cheap)).toHaveLength(1);
  });
});
