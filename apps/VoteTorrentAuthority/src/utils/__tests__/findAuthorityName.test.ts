import { findAuthorityName } from '../findAuthorityName';

type A = { id: string; name: string };
const cursor = (buffer: A[], lastEOF: boolean) => ({ buffer, offset: 0, firstBOF: true, lastEOF });

function engine(opts: { pinned?: A[] | Error; pages?: A[][] }) {
  const pages = opts.pages ?? [];
  let i = 0;
  return {
    getPinnedAuthorities: jest.fn(async () => {
      if (opts.pinned instanceof Error) throw opts.pinned;
      return opts.pinned ?? [];
    }),
    getAuthoritiesByName: jest.fn(async () => cursor((pages[0] ?? []) as never[], pages.length <= 1) as never),
    nextAuthoritiesByName: jest.fn(async () => {
      i++;
      return cursor((pages[i] ?? []) as never[], i >= pages.length - 1) as never;
    }),
  };
}

describe('findAuthorityName', () => {
  it('returns the pinned name without listing', async () => {
    const e = engine({ pinned: [{ id: 'a1', name: 'Lab Auth' }] });
    await expect(findAuthorityName(e as never, 'a1')).resolves.toBe('Lab Auth');
    expect(e.getAuthoritiesByName).not.toHaveBeenCalled();
  });

  it('pages the authority list when the id is not pinned', async () => {
    const e = engine({ pages: [[{ id: 'a0', name: 'Zero' }], [{ id: 'a1', name: 'Lab Auth' }]] });
    await expect(findAuthorityName(e as never, 'a1')).resolves.toBe('Lab Auth');
    expect(e.nextAuthoritiesByName).toHaveBeenCalledTimes(1);
  });

  it('still lists when the pinned read throws', async () => {
    const e = engine({ pinned: new Error('x'), pages: [[{ id: 'a1', name: 'Lab Auth' }]] });
    await expect(findAuthorityName(e as never, 'a1')).resolves.toBe('Lab Auth');
  });

  it('returns undefined for an unknown id, an empty name, or an empty id', async () => {
    await expect(findAuthorityName(engine({ pages: [[{ id: 'a0', name: 'Zero' }]] }) as never, 'a1')).resolves.toBeUndefined();
    await expect(findAuthorityName(engine({ pinned: [{ id: 'a1', name: '' }] }) as never, 'a1')).resolves.toBeUndefined();
    await expect(findAuthorityName(engine({}) as never, '')).resolves.toBeUndefined();
  });
});
