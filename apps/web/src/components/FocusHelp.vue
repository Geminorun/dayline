<script setup lang="ts">
import { tr } from '../i18n/index';
import { useId } from 'vue';
import PlannerIcon from './PlannerIcon.vue';
defineProps<{
  date: string;
  count: number;
  future: boolean;
  selected?: boolean;
}>();
const emit = defineEmits<{ toggle: [] }>();
const id = useId();
</script>
<template>
  <span class="focus-help">
    <button
      type="button"
      class="icon-btn"
      :aria-describedby="id"
      :class="{ 'is-active': selected }"
      :aria-pressed="!!selected"
      @click="emit('toggle')"
      :aria-label="
        tr('focusHelp.highlightsOfItems', {
          value0: date,
          value1: count,
          value2: selected
            ? tr('common.showAllEntries')
            : tr('common.onlyFocusOnTheImportantPoints'),
        })
      "
    >
      <PlannerIcon name="star" /><span v-if="count" class="focus-help-count">{{
        count
      }}</span>
    </button>
    <span :id="id" role="tooltip" class="focus-help-tooltip"
      ><strong>{{
        tr('focusHelp.highlightsOfItems2', { value0: date, value1: count })
      }}</strong
      ><span>{{
        future
          ? tr('focusHelp.canRecordTheKeyPointsOfToday')
          : tr('focusHelp.clickToSeeOnlyTheHighlightsOf')
      }}</span></span
    >
  </span>
</template>
