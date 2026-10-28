<script setup lang="ts">
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
  <section class="entry-details" aria-label="事项详情">
    <div class="modal-header">
      <span class="category-badge"
        ><i class="category-dot" :style="{ background: category?.color }"></i
        >{{ category?.name }}</span
      >
      <div class="actions">
        <IconButton
          v-if="!readonly"
          icon="edit"
          label="编辑事项"
          @click="emit('edit')"
        /><IconButton icon="close" label="关闭详情" @click="emit('close')" />
      </div>
    </div>
    <h2>{{ entry.title }}</h2>
    <span class="detail-status">{{
      entryStatus(entry, today) === 'ongoing' ? '进行中' : '已结束'
    }}</span>
    <dl class="entry-detail-fields">
      <div>
        <dt>开始日期</dt>
        <dd>{{ entry.startDate }}</dd>
      </div>
      <div>
        <dt>结束日期</dt>
        <dd>
          {{ entry.endDate ?? (entry.startDate > today ? '结束未定' : '至今') }}
        </dd>
      </div>
      <div>
        <dt>
          {{
            entry.startDate > today
              ? '计划跨度'
              : entry.endDate
                ? '持续时间'
                : '已持续'
          }}
        </dt>
        <dd>
          {{
            entry.startDate > today && !entry.endDate
              ? '待开始'
              : `${durationDays(entry, today)} 天`
          }}
        </dd>
      </div>
      <div>
        <dt>重点日期</dt>
        <dd>{{ dates.length }} 天</dd>
      </div>
    </dl>
    <details v-if="dates.length" class="detail-focus-dates">
      <summary>查看重点日期</summary>
      <p>{{ dates.join('、') }}</p>
    </details>
  </section>
</template>
