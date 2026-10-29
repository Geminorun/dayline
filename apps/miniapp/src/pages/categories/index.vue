<script setup lang="ts">
import { tr } from '../../i18n/index';
import { msg } from '@dayline/locales';
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { nextCategoryColor } from '@dayline/core';
import { createCategorySchema } from '@dayline/contracts';
import type { CategoryDto } from '@dayline/contracts';
import { useWorkspace, records, message } from '../../workspace';
import { newId } from '../../adapters/uuid';
const { snapshot, loading, busy, error, notice, readonly, ensure, mutate } =
  useWorkspace();
const name = ref(''),
  color = ref(nextCategoryColor([])),
  edit = ref<CategoryDto | null>(null),
  id = ref(''),
  deleting = ref<CategoryDto | null>(null),
  fallbackId = ref(''),
  deletionVersion = ref('');
const entries = computed(() => [
  ...(snapshot.value?.entries ?? []),
  ...(snapshot.value?.trashEntries ?? []),
]);
onShow(async () => {
  await ensure();
  if (!edit.value && !name.value)
    color.value = nextCategoryColor(
      snapshot.value?.categories.map((c) => c.color) ?? [],
    );
});
function start(c: CategoryDto) {
  edit.value = { ...c };
  name.value = c.name;
  color.value = c.color;
}
function reset() {
  edit.value = null;
  id.value = '';
  name.value = '';
  color.value = nextCategoryColor(
    snapshot.value?.categories.map((c) => c.color) ?? [],
  );
}
async function save() {
  error.value = '';
  try {
    if (!id.value) id.value = await newId();
    const input = createCategorySchema.safeParse({
      id: edit.value?.id ?? id.value,
      name: name.value,
      color: color.value,
    });
    if (!input.success) {
      error.value = msg('mini.categoryNamesMustBe112Characters');
      return;
    }
    if (edit.value) {
      const c = edit.value,
        patch = {
          name: input.data.name,
          color: input.data.color,
          expectedVersion: c.version,
        };
      await mutate({ kind: 'updateCategory', id: c.id, input: patch }, () =>
        records.updateCategory(c.id, patch),
      );
    } else
      await mutate({ kind: 'createCategory', input: input.data }, () =>
        records.createCategory(input.data),
      );
    reset();
  } catch (cause) {
    error.value = message(cause);
  }
}
function confirmDelete(c: CategoryDto) {
  deleting.value = { ...c };
  fallbackId.value = '';
  deletionVersion.value = snapshot.value?.dataVersion ?? '';
}
async function remove() {
  const c = deleting.value;
  if (!c) return;
  error.value = '';
  try {
    if (!fallbackId.value) fallbackId.value = await newId();
    const input = {
      expectedVersion: c.version,
      mode: 'trash' as const,
      expectedDataVersion: deletionVersion.value,
      fallbackCategoryId: fallbackId.value,
    };
    await mutate({ kind: 'deleteCategory', id: c.id, input }, () =>
      records.deleteCategory(c.id, input),
    );
    deleting.value = null;
  } catch (cause) {
    error.value = message(cause);
  }
}
</script>
<template>
  <view class="page"
    ><text class="title">{{ tr('common.categoryManagement') }}</text
    ><text class="text muted">{{
      tr('mini.maximum20AtLeastOneDeletingA')
    }}</text
    ><text v-if="loading" class="text">{{ tr('common.loading') }}</text
    ><text v-if="error" class="text error">{{ error }}</text
    ><text v-if="notice" class="text notice">{{ notice }}</text
    ><template v-if="snapshot"
      ><view v-for="c in snapshot.categories" :key="c.id" class="card"
        ><text class="heading"
          ><text :style="{ color: c.color }">● </text
          >{{
            tr('mini.includingTrash', {
              value0: c.name,
              value1: entries.filter((e) => e.categoryId === c.id).length,
            })
          }}</text
        ><view v-if="!readonly" class="actions"
          ><button class="secondary" :disabled="busy" @click="start(c)">
            {{ tr('common.changeNameColor') }}</button
          ><button
            class="secondary"
            :disabled="busy || snapshot.categories.length <= 1"
            @click="confirmDelete(c)"
          >
            {{ tr('common.deleteCategory') }}
          </button></view
        ></view
      ><view v-if="!readonly" class="card"
        ><text class="heading">{{
          edit ? tr('common.modifyCategory') : tr('common.newCategory2')
        }}</text
        ><text class="text">{{ tr('common.categoryName') }}</text
        ><input
          v-model="name"
          :maxlength="24"
          :aria-label="tr('common.categoryName')"
        /><text class="text">{{ tr('mini.colorRrggbb') }}</text
        ><input
          v-model="color"
          :aria-label="tr('common.categoryColor')"
        /><button :disabled="busy" @click="save">
          {{
            edit
              ? tr('common.saveCategoryChanges')
              : tr('common.createACategory2')
          }}</button
        ><button v-if="edit" class="secondary" :disabled="busy" @click="reset">
          {{ tr('common.cancelModification') }}
        </button></view
      ><view v-if="deleting" class="card confirmation"
        ><text class="heading">{{
          tr('mini.delete', { value0: deleting.name })
        }}</text
        ><text class="text">{{
          tr('mini.containsRecordsWhichWillBeTrashedAfter', {
            value0: entries.filter((e) => e.categoryId === deleting?.id).length,
          })
        }}</text
        ><button :disabled="busy" @click="remove">
          {{ tr('common.deleteCategoriesAndRecords') }}</button
        ><button class="secondary" :disabled="busy" @click="deleting = null">
          {{ tr('common.cancel') }}
        </button></view
      >
    </template>
  </view>
</template>
