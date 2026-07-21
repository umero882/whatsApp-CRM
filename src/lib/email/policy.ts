export const FAQ_AUTO_INTENTS = new Set([
  'registration_help', 'app_download', 'pricing_info', 'how_it_works', 'general_info',
]);
export const SENSITIVE_EMAIL_CATEGORIES = new Set([
  'billing_dispute', 'refund', 'safety', 'harassment', 'legal', 'account_deletion', 'fraud', 'account_suspended',
]);

export function mayAutoSend(intent: string, confidence: number, threshold = 0.75): boolean {
  if (SENSITIVE_EMAIL_CATEGORIES.has(intent)) return false;
  if (!FAQ_AUTO_INTENTS.has(intent)) return false;
  return confidence >= threshold;
}
