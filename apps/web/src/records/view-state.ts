import { reactive } from 'vue';
import { emptyFilter } from '@dayline/core';
import type { TimelineScale } from '@dayline/core';
export const recordView = reactive({
  selectedDate: '',
  filter: emptyFilter(),
  scale: 'month' as TimelineScale,
  anchor: '',
  limit: 40,
  returnPath: '/entries',
  scrollTop: 0,
  timelineTop: 0,
  timelineLeft: 0,
});
