import { tr } from '../i18n/index';
import { themePalettes } from '@dayline/core';
export {
  mixColor,
  normalizeHex,
  contrastRatio,
  readableAccent,
} from '@dayline/core';
export type {
  Palette,
  AppearanceMode,
  ColorMode,
  ThemeId,
} from '@dayline/core';
export const themePresets = themePalettes.map((item) => ({
  ...item,
  get name() {
    return 'nameKey' in item ? tr(item.nameKey) : item.name;
  },
  get description() {
    return tr(item.descriptionKey);
  },
}));
