<script setup lang="ts">
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { createCategorySchema } from '@dayline/contracts';
import type { CategoryDto } from '@dayline/contracts';
import { useWorkspace, records, message } from '../../workspace';
import { newId } from '../../adapters/uuid';
const { snapshot, loading, busy, error, notice, readonly, ensure, mutate } =
  useWorkspace();
const name = ref(''),
  color = ref('#8B80D8'),
  edit = ref<CategoryDto | null>(null),
  id = ref(''),
  deleting = ref<CategoryDto | null>(null),
  target = ref('');
const entries = computed(() => [
    ...(snapshot.value?.entries ?? []),
    ...(snapshot.value?.trashEntries ?? []),
  ]),
  targets = computed(
    () =>
      snapshot.value?.categories.filter((c) => c.id !== deleting.value?.id) ??
      [],
  );
onShow(ensure);
function start(c: CategoryDto) {
  edit.value = { ...c };
  name.value = c.name;
  color.value = c.color;
}
function reset() {
  edit.value = null;
  id.value = '';
  name.value = '';
  color.value = '#8B80D8';
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
async function remove() {
  const c = deleting.value,
    t = targets.value.find((c) => c.id === target.value);
  if (!c || !t) return;
  error.value = '';
  const input = {
    expectedVersion: c.version,
    transferToCategoryId: t.id,
    expectedTargetVersion: t.version,
  };
  try {
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
      >最多 20 个、至少一个。删除会转移活动及回收站事项。</text
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
            @click="
              deleting = { ...c };
              target = targets[0]?.id ?? '';
            "
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
        ><text class="text"
          >删除“{{ deleting.name }}”，将
          {{ entries.filter((e) => e.categoryId === deleting?.id).length }}
          条事项转入：</text
        ><picker
          :range="targets.map((c) => c.name)"
          @change="target = targets[Number($event.detail.value)]?.id ?? ''"
          ><view class="picker"
            >{{
              targets.find((c) => c.id === target)?.name ?? '选择接收分类'
            }}
            ▾</view
          ></picker
        ><button :disabled="busy || !target" @click="remove">
          确认转移并删除分类</button
        ><button class="secondary" :disabled="busy" @click="deleting = null">
          取消删除
        </button></view
      ></template
    ></view
  >
</template>
