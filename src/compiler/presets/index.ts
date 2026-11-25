import { componentName } from '../components.js';
import { elementPlusPreset } from './element-plus.js';
import { antDesignPreset } from './ant-design.js';
import { naiveUIPreset } from './naive-ui.js';
import type { ComponentPreset, ComponentReference } from './types.js';

// Small opt-in registry. Library layout and slot rules stay in their own modules.
const presets: readonly ComponentPreset[] = [naiveUIPreset, elementPlusPreset, antDesignPreset('ant-design-vue'), antDesignPreset('antd')];
export const presetNames = presets.map(preset => preset.id);
export function resolvePreset(enabled: readonly string[] | undefined, reference?: ComponentReference) {
  if (!reference || reference.file) return;
  for (const preset of presets) {
    if (!enabled?.includes(preset.id)) continue;
    const name = preset.resolve ? preset.resolve(reference) : reference.request === preset.package ? componentName(reference.exported) : undefined;
    if (name && preset.role(name, {})) return { preset, name };
  }
}
