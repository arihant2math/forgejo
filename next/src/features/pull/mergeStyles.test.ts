import {describe, expect, it} from 'vitest';
import {mergeOptions} from './mergeStyles';

describe('merge options from the synced pull unit', () => {
  it('offers only allowed methods and starts with the repository default', () => {
    const config = {AllowMerge: false, AllowRebase: false, AllowRebaseMerge: false, AllowSquash: true, AllowFastForwardOnly: false, DefaultMergeStyle: 'squash', AllowRebaseUpdate: false};
    const options = mergeOptions(config);
    expect(options.styles.map((m) => m.style)).toEqual(['squash']);
    expect(options.primary?.style).toBe('squash');
    expect(options.rebaseUpdate).toBe(false);
    expect(mergeOptions({...config, AllowRebase: true, DefaultMergeStyle: 'rebase', AllowRebaseUpdate: true}).primary?.style).toBe('rebase');
  });
  it('falls back to an allowed default and never offers manual marking', () => {
    expect(mergeOptions({AllowMerge: false, DefaultMergeStyle: 'merge'}).primary?.style).toBe('rebase');
    expect(mergeOptions({}).styles.some((m) => m.style === 'manually-merged')).toBe(false);
    expect(mergeOptions({AllowMerge: false, AllowRebase: false, AllowRebaseMerge: false, AllowSquash: false, AllowFastForwardOnly: false}).primary).toBeUndefined();
  });
});
