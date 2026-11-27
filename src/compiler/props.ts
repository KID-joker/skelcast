import type { Value } from './expression.js';

/** Vue accepts hyphenated prop names while component expressions use camelCase. */
export const camelizeProp = (name: string): string =>
  name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** Aliases only: callers retain their original keys and default/override policy. */
export function camelProps(props: Record<string, Value>): Record<string, Value> {
  return Object.fromEntries(Object.entries(props).map(([key, value]) => [camelizeProp(key), value]));
}
