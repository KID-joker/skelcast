import { SOURCE_INITIAL, UNKNOWN, type Value } from './expression.js';

/** Vue accepts hyphenated prop names while component expressions use camelCase. */
export const camelizeProp = (name: string): string =>
  name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** Aliases only: callers retain their original keys and default/override policy. */
export function camelProps(props: Record<string, Value>): Record<string, Value> {
  return Object.fromEntries(Object.entries(props).map(([key, value]) => [camelizeProp(key), value]));
}

/** Templates keep raw defaults and source-only initial facts. Setup parameters
 * receive defaults and aliases before projection, including independent copies
 * of projected objects. Both callers share the rules and retain their ordering. */
export function componentInputs(props: Record<string, Value>, defaults: Record<string, Value>, mode: 'template' | 'setup') {
  if (mode === 'setup') props = { ...defaults, ...props, ...camelProps(props) };
  const values: Record<string, Value> = {}, initial: Record<string, Value> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined && Object.hasOwn(defaults, key)) { values[key] = defaults[key]; initial[key] = defaults[key]; continue; }
    if (value && typeof value === 'object' && Object.hasOwn(value, SOURCE_INITIAL)) {
      initial[key] = (value as { [SOURCE_INITIAL]: Value })[SOURCE_INITIAL];
      values[key] = Object.keys(value).length ? Object.fromEntries(Object.entries(value)) : UNKNOWN;
    } else { values[key] = value; initial[key] = value; }
  }
  return { values: mode === 'setup' ? values : { ...defaults, ...values, ...camelProps(values) }, initial };
}

/** Presets retain source keys and explicit camelCase values; DOM attributes
 * such as data-* and aria-* never become component prop aliases. */
export function presetProps(props: Record<string, Value>): Record<string, Value> {
  const result = { ...props };
  for (const [key, value] of Object.entries(props)) {
    if (/^(?:data|aria)-/.test(key)) continue;
    const camel = camelizeProp(key);
    if (!(camel in result)) result[camel] = value;
  }
  return result;
}
