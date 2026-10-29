<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { CATEGORY_PALETTE, nextCategoryColor } from '@dayline/core';
import { createCategorySchema } from '@dayline/contracts';
import type { CategoryDto } from '@dayline/contracts';
import { useWorkspace, records, message } from '../../workspace';
import { newId } from '../../adapters/uuid';
import PageShell from '../../components/PageShell.vue';
import SyncStatus from '../../components/SyncStatus.vue';
import IconButton from '../../components/IconButton.vue';
import BottomSheet from '../../components/BottomSheet.vue';
import MiniIcon from '../../components/MiniIcon.vue';
const w = useWorkspace(),
  { snapshot, busy, error, readonly, ensure, mutate } = w;
const name = ref(''),
  color = ref(nextCategoryColor([])),
  edit = ref<CategoryDto | null>(null),
  id = ref(''),
  editing = ref(false),
  deleting = ref<CategoryDto | null>(null),
  fallbackId = ref(''),
  deletionVersion = ref(''),
  deletionCount = ref(0);
const ids = ref<string[]>([]),
  dragging = ref(''),
  sortSaving = ref(false);
const categories = computed(() => snapshot.value?.categories ?? []),
  ordered = computed(() =>
    ids.value.flatMap((id) => {
      const c = categories.value.find((c) => c.id === id);
      return c ? [c] : [];
    }),
  );
const entries = computed(() => [
  ...(snapshot.value?.entries ?? []),
  ...(snapshot.value?.trashEntries ?? []),
]);
watch(
  categories,
  () => {
    if (!dragging.value && !sortSaving.value)
      ids.value = categories.value.map((c) => c.id);
  },
  { immediate: true },
);
watch(
  () => w.spaceRevision.value,
  () => {
    dragging.value = '';
    editing.value = false;
    deleting.value = null;
    ids.value = categories.value.map((c) => c.id);
  },
);
onShow(ensure);
function start(c: CategoryDto | null = null) {
  error.value = '';
  edit.value = c ? { ...c } : null;
  name.value = c?.name ?? '';
  color.value =
    c?.color ?? nextCategoryColor(categories.value.map((c) => c.color));
  id.value = '';
  editing.value = true;
}
function recommend() {
  color.value = nextCategoryColor(
    categories.value.filter((c) => c.id !== edit.value?.id).map((c) => c.color),
  );
}
async function save() {
  error.value = '';
  const scope = w.generation();
  try {
    if (!id.value) id.value = await newId();
    if (scope !== w.generation()) return;
    const parsed = createCategorySchema.safeParse({
      id: edit.value?.id ?? id.value,
      name: name.value,
      color: color.value,
    });
    if (!parsed.success) {
      error.value = '分类名称须为 1–12 个字符，请选择有效颜色。';
      return;
    }
    if (edit.value) {
      const c = edit.value,
        input = {
          name: parsed.data.name,
          color: parsed.data.color,
          expectedVersion: c.version,
        };
      await mutate({ kind: 'updateCategory', id: c.id, input }, () =>
        records.updateCategory(c.id, input),
      );
    } else
      await mutate({ kind: 'createCategory', input: parsed.data }, () =>
        records.createCategory(parsed.data),
      );
    if (scope === w.generation()) editing.value = false;
  } catch (cause) {
    if (scope === w.generation()) error.value = message(cause);
  }
}
function confirmDelete(c: CategoryDto) {
  deleting.value = { ...c };
  fallbackId.value = '';
  deletionVersion.value = snapshot.value?.dataVersion ?? '';
  deletionCount.value = entries.value.filter(
    (e) => e.categoryId === c.id,
  ).length;
}
async function remove() {
  const c = deleting.value,
    scope = w.generation();
  if (!c) return;
  try {
    if (!fallbackId.value) fallbackId.value = await newId();
    if (scope !== w.generation()) return;
    const input = {
      expectedVersion: c.version,
      mode: 'trash' as const,
      expectedDataVersion: deletionVersion.value,
      fallbackCategoryId: fallbackId.value,
    };
    await mutate({ kind: 'deleteCategory', id: c.id, input }, () =>
      records.deleteCategory(c.id, input),
    );
    if (scope === w.generation()) deleting.value = null;
  } catch (cause) {
    if (scope === w.generation()) error.value = message(cause);
  }
}
interface DragEvent {
  touches: ArrayLike<{ clientY: number }>;
}
let startY = 0,
  startIndex = 0,
  baseline: string[] = [],
  sortVersion = '',
  sortScope = -1;
function touchStart(event: DragEvent) {
  startY = event.touches[0]?.clientY ?? 0;
}
function beginDrag(c: CategoryDto, index: number) {
  if (busy.value || readonly.value || sortSaving.value) return;
  dragging.value = c.id;
  startIndex = index;
  baseline = [...ids.value];
  sortVersion = snapshot.value?.dataVersion ?? '';
  sortScope = w.generation();
  uni.vibrateShort?.({ type: 'light' });
}
function dragMove(event: DragEvent) {
  if (!dragging.value) return;
  const index = Math.max(
      0,
      Math.min(
        ids.value.length - 1,
        startIndex +
          Math.round(((event.touches[0]?.clientY ?? startY) - startY) / 72),
      ),
    ),
    next = baseline.filter((id) => id !== dragging.value);
  next.splice(index, 0, dragging.value);
  ids.value = next;
}
function cancelDrag() {
  dragging.value = '';
  ids.value = categories.value.map((c) => c.id);
}
async function finishDrag() {
  if (!dragging.value) return;
  dragging.value = '';
  if (sortScope !== w.generation()) {
    cancelDrag();
    return;
  }
  if (ids.value.join(',') === baseline.join(',')) return;
  const scope = sortScope,
    input = { categoryIds: [...ids.value], expectedDataVersion: sortVersion };
  sortSaving.value = true;
  try {
    await mutate({ kind: 'reorderCategories', input }, () =>
      records.reorderCategories(input),
    );
  } catch (cause) {
    if (scope === w.generation()) error.value = message(cause);
  } finally {
    sortSaving.value = false;
    ids.value = categories.value.map((c) => c.id);
  }
}
</script>
<template>
  <PageShell
    ><view class="screen-heading"
      ><view
        ><text class="eyebrow">我的空间</text
        ><text class="title">分类管理</text></view
      ><SyncStatus /></view
    ><text class="text muted">长按左侧手柄调整顺序，最多 20 个分类。</text
    ><view v-if="snapshot" class="card category-list"
      ><view
        v-for="(c, index) in ordered"
        :key="c.id"
        class="category-row"
        :class="{ dragging: dragging === c.id }"
        ><view
          class="drag-handle"
          role="button"
          :aria-label="'长按排序 ' + c.name"
          @touchstart="touchStart"
          @longpress="beginDrag(c, index)"
          @touchmove.stop.prevent="dragMove"
          @touchend="finishDrag"
          @touchcancel="cancelDrag"
          ><MiniIcon name="list" :size="18" /></view
        ><view class="category-label"
          ><text class="category-name"
            ><text :style="{ color: c.color }">● </text>{{ c.name }}</text
          ><text class="muted"
            >{{
              entries.filter((e) => e.categoryId === c.id).length
            }}
            条记录</text
          ></view
        ><view v-if="!readonly" class="category-tools"
          ><IconButton
            icon="edit"
            :label="'修改 ' + c.name"
            :disabled="busy || sortSaving"
            @click="start(c)" /><IconButton
            icon="palette"
            :label="'更改 ' + c.name + ' 颜色'"
            :disabled="busy || sortSaving"
            @click="start(c)" /><IconButton
            icon="trash"
            :label="'删除 ' + c.name"
            :disabled="busy || sortSaving || categories.length <= 1"
            @click="confirmDelete(c)" /></view></view></view
    ><button
      v-if="!readonly"
      :disabled="busy || sortSaving || categories.length >= 20"
      @click="start()"
    >
      ＋ 添加分类
    </button>
    <BottomSheet
      v-if="editing"
      :title="edit ? '修改分类' : '添加分类'"
      @close="editing = false"
      ><text class="text">分类名称</text
      ><input
        v-model="name"
        :maxlength="24"
        aria-label="分类名称"
        placeholder="例如：阅读、运动"
      /><view class="section-heading"
        ><text class="text">分类颜色</text
        ><button class="text-button" @click="recommend">自动推荐</button></view
      ><view class="color-grid"
        ><button
          v-for="value in CATEGORY_PALETTE"
          :key="value"
          class="color-swatch"
          :style="{ backgroundColor: value }"
          :class="{ chosen: color.toUpperCase() === value.toUpperCase() }"
          :aria-label="'选择颜色 ' + value"
          @click="color = value"
        >
          <MiniIcon
            v-if="color.toUpperCase() === value.toUpperCase()"
            name="check"
            color="#ffffff"
            :size="18"
          /></button></view
      ><text v-if="error" class="text error">{{ error }}</text
      ><button :disabled="busy" @click="save">保存</button></BottomSheet
    >
    <BottomSheet
      v-if="deleting"
      :title="'删除“' + deleting.name + '”？'"
      @close="deleting = null"
      ><text class="text"
        >共 {{ deletionCount }} 条记录。删除分类后，记录将移入回收站，30
        天内可以恢复。</text
      ><text v-if="error" class="text error">{{ error }}</text
      ><button class="danger" :disabled="busy" @click="remove">
        删除分类及记录</button
      ><button class="secondary" :disabled="busy" @click="deleting = null">
        取消
      </button></BottomSheet
    >
  </PageShell>
</template>
<style scoped>
.category-list {
  padding: 0 10rpx;
}
.category-row {
  display: flex;
  align-items: center;
  height: 72px;
  border-bottom: 1px solid var(--line);
  box-sizing: border-box;
  gap: 8rpx;
}
.category-row:last-child {
  border: 0;
}
.category-row.dragging {
  background: var(--accent-soft);
  border-radius: 12rpx;
}
.drag-handle {
  width: 32px;
  min-width: 32px;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.category-label {
  flex: 1;
  min-width: 0;
}
.category-name {
  display: block;
  font-size: 28rpx;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.category-label .muted {
  display: block;
  font-size: 21rpx;
  margin-top: 6rpx;
}
.category-tools {
  display: flex;
}
.category-tools .icon-button {
  width: 44px;
  min-width: 44px;
  padding: 10px;
}
.color-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 20rpx;
  margin: 20rpx 0;
}
.color-swatch {
  width: 44px;
  height: 44px;
  min-height: 44px;
  min-width: 44px;
  margin: 0;
  border: 2px solid transparent;
  padding: 0;
  border-radius: 50%;
}
.color-swatch.chosen {
  outline: 2px solid var(--ink);
  outline-offset: 3px;
}
</style>
