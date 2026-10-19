import { expect, it } from 'vitest';
import { gitProviderRepositorySchema, gitProviderRepositoryPageSchema } from '../index.js';
it('validates the upstream provider repository wire shape and page defaults', () => {
  const item = { id: '123', full_name: 'owner/repo', git_provider: 'github', is_public: false };
  expect(gitProviderRepositorySchema.parse(item)).toEqual({ ...item, stargazers_count: null, pushed_at: null, main_branch: null });
  expect(gitProviderRepositoryPageSchema.parse({ items: [item] })).toEqual({ items: [gitProviderRepositorySchema.parse(item)], next_page_id: null, missing_token: false });
  expect(gitProviderRepositoryPageSchema.parse({ items: [], missing_token: true, next_page_id: 'cursor' }).missing_token).toBe(true);
  expect(() => gitProviderRepositorySchema.parse({ ...item, is_public: 'yes' })).toThrow();
});
