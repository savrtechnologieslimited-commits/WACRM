import { describe, expect, it } from 'vitest';
import { resolveSection, SETTINGS_SECTIONS } from './settings-sections';

describe('settings sections', () => {
  it('does not expose standalone login and security settings', () => {
    expect(SETTINGS_SECTIONS).not.toContain('security');
    expect(resolveSection('security')).toBe('overview');
  });
});
