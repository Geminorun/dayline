<script setup lang="ts">
import { tr, messageRef } from '../i18n/index';
import { msg } from '@dayline/locales';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import Sortable from 'sortablejs';
import type { CategoryDto } from '@dayline/contracts';
import PlannerIcon from './PlannerIcon.vue';
import { errorMessage } from '../records/record-service';
const props = defineProps<{
  categories: CategoryDto[];
  selected: string;
  disabled: boolean;
  reorder: (ids: string[]) => Promise<unknown>;
}>();
const emit = defineEmits<{ select: [id: string] }>();
const ids = ref(props.categories.map((c) => c.id));
const list = ref<HTMLElement | null>(null);
const saving = ref(false),
  error = messageRef(),
  announcement = messageRef();
const ordered = computed(() =>
  ids.value.flatMap((id) => {
    const category = props.categories.find((c) => c.id === id);
    return category ? [category] : [];
  }),
);
let sortable: Sortable | undefined,
  alive = true,
  ignoreClickUntil = 0;
watch(
  () => props.categories,
  (categories) => {
    ids.value = categories.map((c) => c.id);
    error.value = '';
  },
);
watch(
  () => props.disabled || saving.value,
  (disabled) => sortable?.option('disabled', disabled),
);
async function publish(next: string[], focusId?: string) {
  if (
    props.disabled ||
    saving.value ||
    next.every((id, i) => ids.value[i] === id)
  )
    return;
  ids.value = next;
  saving.value = true;
  error.value = '';
  try {
    await props.reorder(next);
    if (alive) announcement.value = msg('common.sortingOrderSaved');
  } catch (cause) {
    if (alive) {
      ids.value = props.categories.map((c) => c.id);
      error.value = msg('categoryTabs.sortingOrderNotSaved', {
        value0: errorMessage(cause),
      });
    }
  } finally {
    if (alive) {
      saving.value = false;
      await nextTick();
      if (focusId)
        list.value
          ?.querySelector<HTMLElement>(`[data-id="${focusId}"]`)
          ?.focus();
    }
  }
}
function select(id: string) {
  if (performance.now() >= ignoreClickUntil) emit('select', id);
}
function move(event: KeyboardEvent, id: string) {
  if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const index = ids.value.indexOf(id),
    target = index + (event.key === 'ArrowLeft' ? -1 : 1);
  if (target < 0 || target >= ids.value.length) return;
  const next = [...ids.value];
  next.splice(index, 1);
  next.splice(target, 0, id);
  void publish(next, id);
}
onMounted(() => {
  if (!list.value) return;
  sortable = Sortable.create(list.value, {
    draggable: '.category-tab',
    dataIdAttr: 'data-id',
    direction: 'horizontal',
    animation: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ? 0
      : 120,
    disabled: props.disabled,
    fallbackTolerance: 6,
    delay: 100,
    delayOnTouchOnly: true,
    ghostClass: 'category-drag-ghost',
    chosenClass: 'category-drag-chosen',
    onEnd() {
      const next = sortable?.toArray() ?? [];
      sortable?.sort(ids.value);
      ignoreClickUntil = performance.now() + 250;
      void publish(next);
    },
  });
});
onBeforeUnmount(() => {
  alive = false;
  sortable?.destroy();
});
</script>
<template>
  <div class="category-tabs-tools">
    <div class="category-filter-strip">
      <button
        type="button"
        class="filter-tab"
        :class="{ active: !selected }"
        :aria-pressed="!selected"
        @click="emit('select', '')"
      >
        {{ tr('common.all') }}
      </button>
      <div
        ref="list"
        class="category-sort-list"
        :aria-label="tr('categoryTabs.categoryYouCanDragOrPressAlt')"
      >
        <button
          v-for="category in ordered"
          :key="category.id"
          type="button"
          class="filter-tab category-tab"
          :data-id="category.id"
          :class="{ active: selected === category.id }"
          :aria-pressed="selected === category.id"
          :title="
            tr('categoryTabs.dragToSortOrPressAltLeft', {
              value0: category.name,
            })
          "
          @keydown="move($event, category.id)"
          @click="select(category.id)"
        >
          {{ category.name }}
        </button>
      </div>
    </div>
    <RouterLink
      class="category-manage-button"
      to="/categories"
      :aria-label="tr('common.managementCategory')"
      :title="tr('common.managementCategory')"
      ><PlannerIcon name="sliders" /><span>{{
        tr('common.manage')
      }}</span></RouterLink
    >
    <span class="sr-only" role="status">{{ announcement }}</span>
    <p v-if="error" class="category-order-error" role="alert">{{ error }}</p>
  </div>
</template>
