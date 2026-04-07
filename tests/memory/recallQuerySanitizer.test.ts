import { describe, expect, it } from 'vitest';

import { sanitizeRecallQuery } from '../../src/memory/recallQuerySanitizer.js';

describe('sanitizeRecallQuery', () => {
  it('normalizes risky recall syntax into safe text tokens', () => {
    expect(sanitizeRecallQuery(`'3 * 3' "[tag]" {code}`)).toBe(
      'apostrophe 3 times 3 apostrophe quote lbracket tag rbracket quote lbrace code rbrace'
    );
  });

  it('returns an empty string when the query becomes empty after sanitizing', () => {
    expect(sanitizeRecallQuery('()')).toBe('');
  });
});
