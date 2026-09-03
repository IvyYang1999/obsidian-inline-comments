import { describe, it, expect } from 'vitest';
import { nextAutoSessionName, validateName, defaultMailbox } from './registry.ts';

describe('nextAutoSessionName', () => {
  it('picks the first free 新会话N', () => {
    expect(nextAutoSessionName([])).toBe('新会话1');
    expect(nextAutoSessionName(['新会话1', '审计员', '新会话2'])).toBe('新会话3');
  });
});

describe('validateName / defaultMailbox', () => {
  it('rejects empty, too short/long, spaces and slashes', () => {
    expect(validateName('')).toBeTruthy();
    expect(validateName('a')).toBeTruthy();
    expect(validateName('有 空格')).toBeTruthy();
    expect(validateName('a/b')).toBeTruthy();
    expect(validateName('日记助理')).toBeNull();
  });
  it('mailbox folder is the short id', () => {
    expect(defaultMailbox('44444444-0000-1111')).toBe('Agent协作空间/信箱/44444444/');
  });
});
