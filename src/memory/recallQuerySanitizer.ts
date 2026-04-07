export function sanitizeRecallQuery(query: string): string {
  return query
    .replace(/\*/g, ' times ')
    .replace(/'/g, ' apostrophe ')
    .replace(/"/g, ' quote ')
    .replace(/\[/g, ' lbracket ')
    .replace(/\]/g, ' rbracket ')
    .replace(/\{/g, ' lbrace ')
    .replace(/\}/g, ' rbrace ')
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
