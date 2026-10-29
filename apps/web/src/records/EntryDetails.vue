<script setup lang="ts">
import { tr } from '../i18n/index';
import { computed } from 'vue';
import { durationDays, entryStatus } from '@dayline/core';
import type { CategoryDto, EntryDto, FocusDayDto } from '@dayline/contracts';
import IconButton from '../components/IconButton.vue';
const props = defineProps<{
  entry: EntryDto;
  categories: CategoryDto[];
  focusDays: FocusDayDto[];
  today: string;
  readonly: boolean;
}>();
const emit = defineEmits<{ edit: []; close: [] }>();
const category = computed(() =>
  props.categories.find((c) => c.id === props.entry.categoryId),
);
const dates = computed(() =>
  props.focusDays
    .filter((f) => f.entryId === props.entry.id && f.focused)
    .map((f) => f.date)
    .sort()
    .reverse(),
);
</script>
<template>
  <section class="entry-details" :aria-label="tr('common.entryDetails')">
    <div class="modal-header">
      <span class="category-badge"
        ><i class="category-dot" :style="{ background: category?.color }"></i
        >{{ category?.name }}</span
      >
      <div class="actions">
        <IconButton
          v-if="!readonly"
          icon="edit"
          :label="tr('common.editEntry')"
          @click="emit('edit')"
        /><IconButton
          icon="close"
          :label="tr('common.closeDetails')"
          @click="emit('close')"
        />
      </div>
    </div>
    <div class="entry-detail-title">
      <h2>{{ entry.title }}</h2>
      <span class="detail-status">{{
        entryStatus(entry, today) === 'ongoing'
          ? tr('common.ongoing')
          : tr('common.ended')
      }}</span>
    </div>
    <dl class="entry-detail-fields">
      <div class="entry-detail-range">
        <dt>{{ tr('common.dates') }}</dt>
        <dd>
          {{ entry.startDate }} <span aria-hidden="true">—</span>
          {{
            entry.endDate ??
            (entry.startDate > today
              ? tr('common.endingPending')
              : tr('common.present'))
          }}
        </dd>
      </div>
      <div>
        <dt>
          {{
            entry.startDate > today
              ? tr('common.planningHorizon')
              : entry.endDate
                ? tr('common.duration')
                : tr('common.duration2')
          }}
        </dt>
        <dd>
          {{
            entry.startDate > today && !entry.endDate
              ? tr('common.toBeStarted')
              : tr('data.days', { value0: durationDays(entry, today) })
          }}
        </dd>
      </div>
      <div>
        <dt>{{ tr('common.focusDates') }}</dt>
        <dd>{{ tr('data.days', { value0: dates.length }) }}</dd>
      </div>
    </dl>
    <details v-if="dates.length" class="detail-focus-dates">
      <summary>{{ tr('common.viewFocusDates') }}</summary>
      <p>{{ dates.join('、') }}</p>
    </details>
  </section>
</template>
