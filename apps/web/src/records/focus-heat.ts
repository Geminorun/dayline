import { tr } from '../i18n/index';
/** Fixed counts keep heat levels comparable while zooming and filtering. */
export const FOCUS_HEAT_STEPS = [
  {
    level: 1,
    from: 1,
    get label() {
      return tr('common.1Day');
    },
  },
  {
    level: 2,
    from: 2,
    get label() {
      return tr('common.23Days');
    },
  },
  {
    level: 3,
    from: 4,
    get label() {
      return tr('common.47Days');
    },
  },
  {
    level: 4,
    from: 8,
    get label() {
      return tr('common.8DaysAndAbove');
    },
  },
] as const;

export { focusHeatLevel } from '@dayline/core';
