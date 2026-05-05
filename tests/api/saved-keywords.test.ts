import { describe, it, expect } from 'vitest';
import { postSchema } from '@/app/api/saved-keywords/route';

describe('postSchema', () => {
  it('有効なキーワードをパースできる', () => {
    const r = postSchema.parse({ keyword: '花江夏樹' });
    expect(r.keyword).toBe('花江夏樹');
  });

  it('空文字列はエラー', () => {
    expect(() => postSchema.parse({ keyword: '' })).toThrow();
  });

  it('101文字はエラー', () => {
    expect(() => postSchema.parse({ keyword: 'a'.repeat(101) })).toThrow();
  });

  it('100文字は有効', () => {
    const r = postSchema.parse({ keyword: 'a'.repeat(100) });
    expect(r.keyword).toHaveLength(100);
  });

  it('keyword フィールドがない場合はエラー', () => {
    expect(() => postSchema.parse({})).toThrow();
  });
});
