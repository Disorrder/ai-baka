/**
 * Детерминированные identity-ключи канонических сущностей (docs/plan.md §7.3).
 */

/**
 * identity_key диалога:
 *   <harness-installation-uuid>:<external-id>
 * Fallback при отсутствии external id:
 *   <harness-installation-uuid>:<source-dialogue-id-or-fingerprint>
 *
 * Одинаковый external id на разных машинах не мержится, потому что
 * installation uuid различен (план §7.3 `dialogue`).
 */
export function dialogueIdentityKey(
  harnessInstallationUuid: string,
  externalId: string | undefined,
  fallbackSourceId: string,
): string {
  const local = externalId && externalId.length > 0 ? externalId : fallbackSourceId;
  return `${harnessInstallationUuid}:${local}`;
}

/**
 * Fallback-id диалога из пути snapshot'а, когда источник не дал
 * собственного id (например, Codex rollout без session_meta).
 * Детерминирован по relative path внутри source root.
 */
export function fallbackDialogueSourceId(harnessSlug: string, relativePath: string): string {
  return `${harnessSlug}:${relativePath}`;
}
