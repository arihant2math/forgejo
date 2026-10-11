import {expect, test} from 'vitest';
import {draftPrefix, draftTitle} from './draft.ts';

test('configured prefixes match Forgejo and toggling preserves the title', () => {
  const prefixes = ['Draft:', '[Work]'];
  expect(draftPrefix('[work] Ship it', prefixes)).toBe('[Work]');
  expect(draftPrefix(' [Work] Ship it', prefixes)).toBeUndefined();
  expect(draftPrefix('WIP: Ship it', prefixes)).toBeUndefined();
  expect(draftTitle('[work] Ship it', false, prefixes)).toBe('Ship it');
  expect(draftTitle('Ship it', true, prefixes)).toBe('Draft: Ship it');
  expect(draftTitle('Draft: Ship it', true, prefixes)).toBe('Draft: Ship it');
  expect(draftTitle('Ship it', true, [])).toBe('Ship it');
});
