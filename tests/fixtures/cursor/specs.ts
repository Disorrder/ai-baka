/**
 * Обезличенные синтетические fixtures формата Cursor state.vscdb
 * (docs/plan.md §11.2). Структура ключей/полей повторяет живой формат
 * (cursorDiskKV composerData/bubbleId, composerHeaders, ItemTable
 * composer.composerHeaders), содержимое вымышленное.
 */

import {
  assistantBubble,
  composerDataSpec,
  toolBubble,
  userBubble,
  workspaceIdentifier,
  type CursorFixtureSpec,
} from "./make-db.ts";

export type { CursorFixtureSpec } from "./make-db.ts";

export const COMPOSER_BASIC = "11111111-aaaa-4bbb-8ccc-111111111111";
export const COMPOSER_TOOLS = "22222222-bbbb-4ccc-8ddd-222222222222";
export const COMPOSER_SECOND = "33333333-cccc-4ddd-8eee-333333333333";
export const COMPOSER_CORRUPT_OK = "44444444-dddd-4eee-8fff-444444444444";
export const COMPOSER_CORRUPT_BAD = "55555555-eeee-4fff-8aaa-555555555555";

const T0 = Date.parse("2026-07-10T12:00:00.000Z");
const T1 = Date.parse("2026-07-10T12:05:00.000Z");
const T2 = Date.parse("2026-07-10T12:09:00.000Z");

/** Обычный диалог: user prompt + assistant ответ, одна модель, usage. */
export const basicDialogue: CursorFixtureSpec = {
  composers: [
    {
      composerId: COMPOSER_BASIC,
      composerData: composerDataSpec({
        composerId: COMPOSER_BASIC,
        name: "Объяснение кэша в src/cache.ts",
        createdAt: T0,
        lastUpdatedAt: T1,
        bubbleRefs: [
          { bubbleId: "b-user-0001", type: 1 },
          { bubbleId: "b-asst-0002", type: 2 },
        ],
        usageData: { "claude-4-sonnet-thinking": { costInCents: 3, amount: 1 } },
        unifiedMode: "chat",
      }),
      header: {
        workspaceId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
        createdAt: T0,
        lastUpdatedAt: T1,
        isArchived: false,
        isSubagent: false,
        value: {
          type: "head",
          composerId: COMPOSER_BASIC,
          workspaceIdentifier: workspaceIdentifier("/Users/example/projects/demo-app"),
        },
      },
      bubbles: [
        {
          bubbleId: "b-user-0001",
          value: userBubble("b-user-0001", "Объясни работу кэша в src/cache.ts"),
        },
        {
          bubbleId: "b-asst-0002",
          value: assistantBubble(
            "b-asst-0002",
            "Кэш в src/cache.ts устроен как in-memory Map с TTL и инвалидацией по тегам.",
            { tokenCount: { inputTokens: 2350, outputTokens: 140 } },
          ),
        },
      ],
    },
  ],
};

/**
 * Tool calls + reasoning + model switch + длинный финальный ответ из
 * нескольких assistant bubbles (текст до и после tool activity, §19.2 №20).
 */
export const toolCallsDialogue: CursorFixtureSpec = {
  composers: [
    {
      composerId: COMPOSER_TOOLS,
      composerData: composerDataSpec({
        composerId: COMPOSER_TOOLS,
        name: "Поиск дублирующихся запросов",
        createdAt: T0,
        lastUpdatedAt: T2,
        isAgentic: true,
        bubbleRefs: [
          { bubbleId: "b-user-1001", type: 1 },
          { bubbleId: "b-think-1002", type: 2 },
          { bubbleId: "b-asst-1003", type: 2 },
          { bubbleId: "b-tool-1004", type: 2 },
          { bubbleId: "b-asst-1005", type: 2 },
          { bubbleId: "b-asst-1006", type: 2 },
        ],
        // Две модели за диалог (model switch): per-message атрибуция
        // невозможна → metadata.models, message.model не назначается.
        usageData: {
          "claude-4-sonnet": { costInCents: 2, amount: 1 },
          "gpt-5.6-sol": { costInCents: 5, amount: 1 },
        },
      }),
      header: {
        workspaceId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
        createdAt: T0,
        value: {
          type: "head",
          composerId: COMPOSER_TOOLS,
          workspaceIdentifier: workspaceIdentifier("/Users/example/projects/demo-app"),
        },
      },
      bubbles: [
        {
          bubbleId: "b-user-1001",
          value: userBubble("b-user-1001", "Найди, где дублируется fetchOrder"),
        },
        {
          bubbleId: "b-think-1002",
          value: assistantBubble(
            "b-think-1002",
            "Сначала нужно понять, как устроен слой API и где вызывается fetchOrder.",
            { isThought: true },
          ),
        },
        {
          bubbleId: "b-asst-1003",
          value: assistantBubble("b-asst-1003", "Сейчас поищу вызовы fetchOrder по проекту."),
        },
        {
          bubbleId: "b-tool-1004",
          value: toolBubble({
            bubbleId: "b-tool-1004",
            toolCallId: "toolu_aaa001",
            name: "grep_search",
            rawArgs: { query: "fetchOrder", caseSensitive: false },
            result: {
              matches: [
                { path: "src/api/orders.ts", line: 12 },
                { path: "src/ui/cart.ts", line: 48 },
              ],
            },
            tokenCount: { inputTokens: 5200, outputTokens: 300 },
          }),
        },
        {
          bubbleId: "b-asst-1005",
          value: assistantBubble(
            "b-asst-1005",
            "Нашёл два вызова. Первый — в api-слое (src/api/orders.ts:12).",
          ),
        },
        {
          bubbleId: "b-asst-1006",
          value: assistantBubble(
            "b-asst-1006",
            "Второй — в UI-корзине (src/ui/cart.ts:48), он дублирует запрос. Рекомендую убрать вызов из корзины и подписаться на store.",
          ),
        },
      ],
    },
  ],
  extraKv: {
    [`checkpointId:${COMPOSER_TOOLS}:ckpt-0001`]: JSON.stringify({ files: [] }),
    [`checkpointId:${COMPOSER_TOOLS}:ckpt-0002`]: JSON.stringify({ files: [] }),
    [`codeBlockDiff:${COMPOSER_TOOLS}:diff-0001`]: JSON.stringify({ diff: "" }),
  },
};

/** Несколько диалогов в одном snapshot'е; второй — только composerData. */
export const multiDialogue: CursorFixtureSpec = {
  composers: [
    {
      composerId: COMPOSER_BASIC,
      composerData: composerDataSpec({
        composerId: COMPOSER_BASIC,
        name: "Первый диалог",
        createdAt: T0,
        bubbleRefs: [
          { bubbleId: "b-user-0001", type: 1 },
          { bubbleId: "b-asst-0002", type: 2 },
        ],
      }),
      header: {
        workspaceId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
        createdAt: T0,
        value: {
          type: "head",
          composerId: COMPOSER_BASIC,
          workspaceIdentifier: workspaceIdentifier("/Users/example/projects/demo-app"),
        },
      },
      bubbles: [
        { bubbleId: "b-user-0001", value: userBubble("b-user-0001", "Привет") },
        { bubbleId: "b-asst-0002", value: assistantBubble("b-asst-0002", "Здравствуйте!") },
      ],
    },
    {
      composerId: COMPOSER_SECOND,
      // Старый формат: массив conversation вместо fullConversationHeadersOnly,
      // без composerHeaders — workspace только из context.workspaceHint.
      composerData: {
        _v: 1,
        composerId: COMPOSER_SECOND,
        name: "Второй диалог",
        createdAt: T1,
        lastUpdatedAt: T2,
        conversation: [
          { type: 1, bubbleId: "b-user-2001" },
          { type: 2, bubbleId: "b-asst-2002" },
        ],
      },
      bubbles: [
        { bubbleId: "b-user-2001", value: userBubble("b-user-2001", "Покажи статус задачи") },
        {
          bubbleId: "b-asst-2002",
          value: assistantBubble("b-asst-2002", "Задача в статусе in_progress."),
        },
      ],
    },
    {
      // Пустой draft без сообщений и имени — пропускается, не диалог.
      composerId: "empty-state-draft",
      composerData: composerDataSpec({
        composerId: "empty-state-draft",
        createdAt: T2,
        bubbleRefs: [],
      }),
    },
  ],
};

/** Неизвестный bubble type (№11) + пустое сообщение. */
export const unknownAndEmpty: CursorFixtureSpec = {
  composers: [
    {
      composerId: COMPOSER_BASIC,
      composerData: composerDataSpec({
        composerId: COMPOSER_BASIC,
        name: "Неизвестные события",
        createdAt: T0,
        bubbleRefs: [
          { bubbleId: "b-user-0001", type: 1 },
          { bubbleId: "b-unknown-0002", type: 99 },
          { bubbleId: "b-asst-0003", type: 2 },
          { bubbleId: "b-asst-0004", type: 2 },
        ],
      }),
      bubbles: [
        { bubbleId: "b-user-0001", value: userBubble("b-user-0001", "Составь список заметок") },
        {
          bubbleId: "b-unknown-0002",
          value: {
            _v: 2,
            type: 99,
            bubbleId: "b-unknown-0002",
            hologramPayload: { rendered: true },
          },
        },
        // Пустое сообщение: text === "", без toolFormerData.
        { bubbleId: "b-asst-0003", value: assistantBubble("b-asst-0003", "") },
        {
          bubbleId: "b-asst-0004",
          value: assistantBubble("b-asst-0004", "Вот список заметок: первая, вторая."),
        },
      ],
    },
  ],
};

/**
 * Corrupted/truncated: composerData одного диалога — битый JSON (диалог
 * пропускается, остальные парсятся); у второго диалога один bubble битый
 * (unknown chunk) и один header ссылается на отсутствующий bubble.
 */
export const corrupted: CursorFixtureSpec = {
  composers: [
    {
      composerId: COMPOSER_CORRUPT_BAD,
      composerData: `{"_v":3,"composerId":"${COMPOSER_CORRUPT_BAD}","name":"Обрезан`,
    },
    {
      composerId: COMPOSER_CORRUPT_OK,
      composerData: composerDataSpec({
        composerId: COMPOSER_CORRUPT_OK,
        name: "Частично битый диалог",
        createdAt: T0,
        bubbleRefs: [
          { bubbleId: "b-user-0001", type: 1 },
          { bubbleId: "b-broken-0002", type: 2 },
          { bubbleId: "b-missing-0003", type: 2 },
          { bubbleId: "b-asst-0004", type: 2 },
        ],
      }),
      bubbles: [
        { bubbleId: "b-user-0001", value: userBubble("b-user-0001", "Расскажи про индексы") },
        { bubbleId: "b-broken-0002", value: `{"_v":2,"type":2,"bubbleId":"b-broken-00` },
        // b-missing-0003 намеренно отсутствует в cursorDiskKV.
        {
          bubbleId: "b-asst-0004",
          value: assistantBubble("b-asst-0004", "Индексы ускоряют выборку по ключу."),
        },
      ],
    },
  ],
};
