/**
 * Политика приватности embeddings (docs/plan.md §13.7).
 *
 * В OpenAI (или другой внешний provider) уходит только content
 * search_document'а; перечисленные harness'ы/workspace'ы/типы документов
 * и документы свыше maxDocumentBytes исключаются. Проверка выполняется
 * worker'ом в момент вызова API (реальная граница утечки): исключённый
 * job переводится в cancelled с last_error = "privacy_excluded: <причина>".
 *
 * Логи не содержат полного отправленного текста (только hash/метаданные).
 */

export interface PrivacyPolicy {
  excludeHarnesses: string[];
  excludeWorkspaces: string[];
  excludeDocumentTypes: string[];
  maxDocumentBytes?: number;
}

export const EMPTY_PRIVACY_POLICY: PrivacyPolicy = {
  excludeHarnesses: [],
  excludeWorkspaces: [],
  excludeDocumentTypes: [],
};

export interface PrivacySubject {
  harness?: string;
  workspace?: string;
  documentType: string;
  /** UTF-8 bytes content'а. */
  contentBytes: number;
}

/** Причина исключения или undefined, если документ можно отправлять. */
export function privacyExclusion(
  subject: PrivacySubject,
  policy: PrivacyPolicy,
): string | undefined {
  if (subject.harness && policy.excludeHarnesses.includes(subject.harness)) {
    return `harness ${subject.harness}`;
  }
  if (subject.workspace && policy.excludeWorkspaces.includes(subject.workspace)) {
    return `workspace ${subject.workspace}`;
  }
  if (policy.excludeDocumentTypes.includes(subject.documentType)) {
    return `document_type ${subject.documentType}`;
  }
  if (policy.maxDocumentBytes !== undefined && subject.contentBytes > policy.maxDocumentBytes) {
    return `document ${subject.contentBytes} bytes > max ${policy.maxDocumentBytes}`;
  }
  return undefined;
}
