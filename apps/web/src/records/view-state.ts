import { reactive } from 'vue';
import { emptyFilter } from '@dayline/core';
import type { TimelineScale } from '@dayline/core';
export const recordView = reactive({
  activeView: 'day' as 'day' | 'timeline',
  selectedDate: '',
  filter: emptyFilter(),
  scale: 'month' as TimelineScale,
  anchor: '',
  limit: 40,
  returnPath: '/day',
  scrollTop: 0,
  timelineTop: 0,
  timelineListTop: 0,
  timelineCameraDay: null as number | null,
  timelineCameraDays: null as number | null,
  focusOnly: false,
});
export function resetRecordView() {
  Object.assign(recordView, {
    activeView: 'day',
    selectedDate: '',
    filter: emptyFilter(),
    scale: 'month',
    anchor: '',
    limit: 40,
    returnPath: '/day',
    scrollTop: 0,
    timelineTop: 0,
    timelineListTop: 0,
    timelineCameraDay: null,
    timelineCameraDays: null,
    focusOnly: false,
  });
}
