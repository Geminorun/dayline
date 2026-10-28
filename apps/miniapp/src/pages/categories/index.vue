<script setup lang="ts">
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
      error.value = '分类名称须为 1–12 字，颜色须为 #RRGGBB。';
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
    ><text class="title">分类管理</text
    ><text class="text muted"
      >最多 20 个、至少一个。删除分类会把记录移入回收站。</text
    ><text v-if="loading" class="text">正在读取…</text
    ><text v-if="error" class="text error">{{ error }}</text
    ><text v-if="notice" class="text notice">{{ notice }}</text
    ><template v-if="snapshot"
      ><view v-for="c in snapshot.categories" :key="c.id" class="card"
        ><text class="heading"
          ><text :style="{ color: c.color }">● </text>{{ c.name }} ·
          {{ entries.filter((e) => e.categoryId === c.id).length }}
          条（含回收站）</text
        ><view v-if="!readonly" class="actions"
          ><button class="secondary" :disabled="busy" @click="start(c)">
            改名 / 改色</button
          ><button
            class="secondary"
            :disabled="busy || snapshot.categories.length <= 1"
            @click="confirmDelete(c)"
          >
            删除分类
          </button></view
        ></view
      ><view v-if="!readonly" class="card"
        ><text class="heading">{{ edit ? '修改分类' : '新建分类' }}</text
        ><text class="text">分类名称</text
        ><input v-model="name" :maxlength="24" aria-label="分类名称" /><text
          class="text"
          >颜色 #RRGGBB</text
        ><input v-model="color" aria-label="分类颜色" /><button
          :disabled="busy"
          @click="save"
        >
          {{ edit ? '保存分类修改' : '创建分类' }}</button
        ><button v-if="edit" class="secondary" :disabled="busy" @click="reset">
          取消修改
        </button></view
      ><view v-if="deleting" class="card confirmation"
        ><text class="heading">删除“{{ deleting.name }}”？</text
        ><text class="text"
          >包含
          {{ entries.filter((e) => e.categoryId === deleting?.id).length }}
          条记录，删除后将进入回收站，30 天内可恢复。</text
        ><button :disabled="busy" @click="remove">删除分类与记录</button
        ><button class="secondary" :disabled="busy" @click="deleting = null">
          取消
        </button></view
      >
    </template>
  </view>
</template>
