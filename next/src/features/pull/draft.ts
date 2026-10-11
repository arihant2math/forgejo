import type {NextConfig} from '../../protocol/types.gen.ts';

export function wipPrefixes(config: NextConfig): string[] {
  return config.wip_prefixes ?? ['WIP:', '[WIP]'];
}

export function draftPrefix(title: string, prefixes: readonly string[]): string | undefined {
  return prefixes.find((prefix) => title.toUpperCase().startsWith(prefix.toUpperCase()));
}

export function draftTitle(title: string, draft: boolean, prefixes: readonly string[]): string {
  const prefix = draftPrefix(title, prefixes);
  if (draft) return prefix === undefined && prefixes[0] ? `${prefixes[0]} ${title}` : title;
  let ready = title;
  let found = prefix;
  while (found) {
    ready = ready.slice(found.length).trimStart();
    found = draftPrefix(ready, prefixes);
  }
  return ready;
}
