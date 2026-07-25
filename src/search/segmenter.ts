/**
 * Сегментация длинных поисковых документов (docs/plan.md §13.4).
 *
 * Документы НЕ обрезаются и не пропускаются: длинный документ разбивается
 * на несколько search_document (segment_no = 0..n-1), короткий — один
 * сегмент. Целевой размер 6000–7000 embedding-токенов, жёсткий предел
 * < 8192 (max input text-embedding-3-*).
 *
 * Подсчёт токенов — эвристика chars/3.5 (консервативная для смешанного
 * русско-английского текста с кодом: для кириллицы BPE-токенов обычно
 * больше, чем chars/3.5, поэтому запас до 8192 оставлен намеренно).
 * Точный tokenizer OpenAI появится на этапе 7 — seam уже есть:
 * segmentDocument принимает counter, и его можно заменить без смены
 * логики границ (тогда bump'нуть SEGMENTATION_VERSION).
 *
 * Приоритет границ (§13.4): Markdown headings → абзацы → code fences
 * целиком → diff/file sections → списки → token-based split.
 * Реализация: текст режется на атомарные блоки — heading (одна строка),
 * fenced code block (``` … ``` целиком), text-блок между пустыми строками
 * (абзац, список или diff-секция: у них нет пустых строк внутри, поэтому
 * они остаются целыми). Сегменты собираются жадно до TARGET; разрыв
 * предпочтительно делается на последнем heading внутри сегмента, иначе —
 * на границе блока у MAX. Блок, превышающий MAX сам по себе, режется по
 * строкам (fence переворачивается маркерами заново), слишком длинная
 * строка — посимвольно (это и есть token-based split последнего уровня).
 *
 * Чистая функция: одинаковый вход → одинаковый выход (детерминированные
 * search_document id, §8.1).
 */

/** Версия логики сегментации (search_document.segmentation_version). */
export const SEGMENTATION_VERSION = "1";

/** Эвристика: символов на embedding-токен (см. шапку файла). */
export const CHARS_PER_TOKEN = 3.5;
/** Целевой размер сегмента (середина 6000–7000 по §13.4). */
export const TARGET_TOKENS = 6500;
/** Жёсткий предел сегмента; с запасом ниже лимита модели 8192. */
export const MAX_TOKENS = 8000;

export type TokenCounter = (text: string) => number;

/** Эвристический counter (chars/3.5); на этапе 7 заменяется точным tokenizer'ом. */
export const heuristicTokenCounter: TokenCounter = (text) =>
  Math.ceil(text.length / CHARS_PER_TOKEN);

export interface Segment {
  content: string;
  /** Оценка token_count сегмента (search_document.token_count). */
  tokenCount: number;
}

type BlockKind = "heading" | "fence" | "text";

interface Block {
  kind: BlockKind;
  text: string;
}

const FENCE_RE = /^\s*```/;
const HEADING_RE = /^#{1,6}(?:\s|$)/;
const BLANK_RE = /^\s*$/;

/** Разбить текст на атомарные блоки (см. шапку). */
function splitBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  let current: string[] = [];
  let fence: string[] | undefined;

  const flushText = (): void => {
    if (current.length === 0) return;
    blocks.push({ kind: "text", text: current.join("\n") });
    current = [];
  };

  for (const line of content.split("\n")) {
    if (fence) {
      fence.push(line);
      if (FENCE_RE.test(line)) {
        blocks.push({ kind: "fence", text: fence.join("\n") });
        fence = undefined;
      }
      continue;
    }
    if (FENCE_RE.test(line)) {
      flushText();
      fence = [line];
      continue;
    }
    if (BLANK_RE.test(line)) {
      flushText();
      continue;
    }
    if (HEADING_RE.test(line)) {
      flushText();
      blocks.push({ kind: "heading", text: line });
      continue;
    }
    current.push(line);
  }
  flushText();
  // Незакрытый fence — до конца документа одним блоком.
  if (fence) blocks.push({ kind: "fence", text: fence.join("\n") });
  return blocks;
}

/**
 * Разрезать блок, превышающий MAX_TOKENS, на подблоки ≤ MAX_TOKENS:
 * сначала по строкам, слишком длинную строку — посимвольно. Fence-блок
 * переворачивается маркерами ``` в каждом подблоке.
 */
function splitOversized(block: Block, counter: TokenCounter): Block[] {
  let lines = block.text.split("\n");
  let fenceOpen: string | undefined;
  let fenceClose: string | undefined;
  if (block.kind === "fence" && lines.length >= 2 && FENCE_RE.test(lines.at(-1)!)) {
    fenceOpen = lines[0];
    fenceClose = lines.at(-1);
    lines = lines.slice(1, -1);
  }
  // Запас на fence-маркеры, чтобы перевёрнутый подблок тоже был ≤ MAX.
  const reserve = fenceOpen ? counter(`${fenceOpen}\n\n${fenceClose}`) : 0;
  const maxChars = Math.floor((MAX_TOKENS - reserve) * CHARS_PER_TOKEN);

  // Посимвольная резка экстремально длинных строк (token-based split).
  const cut: string[] = [];
  for (const line of lines) {
    for (let i = 0; i < line.length; i += maxChars) cut.push(line.slice(i, i + maxChars));
  }

  const out: Block[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    const body = current.join("\n");
    current = [];
    currentTokens = 0;
    out.push({
      kind: block.kind,
      text: fenceOpen ? `${fenceOpen}\n${body}\n${fenceClose}` : body,
    });
  };
  for (const line of cut) {
    const lineTokens = counter(line) + 1; // + "\n"
    if (current.length > 0 && currentTokens + reserve + lineTokens > TARGET_TOKENS) flush();
    current.push(line);
    currentTokens += lineTokens;
  }
  flush();
  return out;
}

/** Жадная сборка блоков в сегменты с предпочтением heading-границ. */
function packBlocks(blocks: Block[], counter: TokenCounter): string[] {
  const segments: string[] = [];
  let current: Block[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    segments.push(current.map((b) => b.text).join("\n\n"));
    current = [];
    currentTokens = 0;
  };

  for (const block of blocks) {
    const blockTokens = counter(block.text);
    if (current.length > 0 && currentTokens + blockTokens > TARGET_TOKENS) {
      // Последний heading внутри сегмента (не первый блок) — лучшая граница.
      let headingIndex = -1;
      for (let i = current.length - 1; i >= 1; i--) {
        if (current[i]!.kind === "heading") {
          headingIndex = i;
          break;
        }
      }
      if (headingIndex > 0) {
        const tail = current.splice(headingIndex);
        flush();
        current = tail;
        currentTokens = tail.reduce((sum, b) => sum + counter(b.text), 0);
      }
      if (current.length > 0 && currentTokens + blockTokens > MAX_TOKENS) flush();
    }
    current.push(block);
    currentTokens += blockTokens;
  }
  flush();
  return segments;
}

/**
 * Разбить документ на сегменты (§13.4). Короткий документ (≤ TARGET) —
 * один сегмент. Гарантии: сегменты покрывают весь документ (блоки идут
 * в исходном порядке, склейка — "\n\n"), каждый сегмент ≤ MAX_TOKENS
 * по переданному counter'у (пустой документ — один пустой сегмент).
 */
export function segmentDocument(
  content: string,
  counter: TokenCounter = heuristicTokenCounter,
): Segment[] {
  if (counter(content) <= TARGET_TOKENS) {
    return [{ content, tokenCount: counter(content) }];
  }
  const blocks: Block[] = [];
  for (const block of splitBlocks(content)) {
    if (counter(block.text) > MAX_TOKENS) blocks.push(...splitOversized(block, counter));
    else blocks.push(block);
  }
  return packBlocks(blocks, counter).map((segment) => ({
    content: segment,
    tokenCount: counter(segment),
  }));
}
