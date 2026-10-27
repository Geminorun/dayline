<script setup lang="ts">
import { ref, inject, watch } from 'vue';
import { routeLocationKey } from 'vue-router';
import PlannerIcon from '../components/PlannerIcon.vue';
import type { CategoryDto, EntryDto, GuestMutation } from '@dayline/contracts';
import { createCategorySchema } from '@dayline/contracts';
import { records, errorMessage } from './record-service';
const props = defineProps<{
  categories: CategoryDto[];
  entries: EntryDto[];
  run?: (action: () => Promise<unknown>) => Promise<unknown>;
  mutate?: (
    mutation: GuestMutation,
    cloud: () => Promise<unknown>,
  ) => Promise<unknown>;
  busy: boolean;
}>();
const creating = ref(false);
const route = inject(routeLocationKey, undefined);
const name = ref('');
const color = ref('#8B80D8');
const edit = ref<CategoryDto | null>(null);
const error = ref('');
const newId = ref(crypto.randomUUID());
const deleting = ref<CategoryDto | null>(null);
const targetId = ref('');
function start(category: CategoryDto) {
  creating.value = true;
  edit.value = category;
  name.value = category.name;
  color.value = category.color;
  error.value = '';
}
function reset() {
  creating.value = false;
  edit.value = null;
  name.value = '';
  color.value = '#8B80D8';
  newId.value = crypto.randomUUID();
}
async function save() {
  const input = createCategorySchema.safeParse({
    id: edit.value?.id ?? newId.value,
    name: name.value,
    color: color.value,
  });
  if (!input.success) {
    error.value = '名称须为 1–12 字，颜色为 #RRGGBB。';
    return;
  }
  error.value = '';
  try {
    const current = edit.value;
    const cloud = () =>
      current
        ? records.updateCategory(current.id, {
            expectedVersion: current.version,
            name: input.data.name,
            color: input.data.color,
          })
        : records.createCategory(input.data);
    if (props.mutate)
      await props.mutate(
        current
          ? {
              kind: 'updateCategory',
              id: current.id,
              input: {
                expectedVersion: current.version,
                name: input.data.name,
                color: input.data.color,
              },
            }
          : { kind: 'createCategory', input: input.data },
        cloud,
      );
    else await props.run?.(cloud);
    reset();
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
async function remove() {
  const source = deleting.value;
  const target = props.categories.find((value) => value.id === targetId.value);
  if (!source || !target) return;
  error.value = '';
  try {
    const input = {
      expectedVersion: source.version,
      transferToCategoryId: target.id,
      expectedTargetVersion: target.version,
    };
    const cloud = () => records.deleteCategory(source.id, input);
    if (props.mutate)
      await props.mutate(
        { kind: 'deleteCategory', id: source.id, input },
        cloud,
      );
    else await props.run?.(cloud);
    deleting.value = null;
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
watch(
  () => [route?.query.edit, route?.query.remove, props.categories] as const,
  () => {
    const editing = props.categories.find(
      (category) => category.id === route?.query.edit,
    );
    if (editing) start(editing);
    const removing = props.categories.find(
      (category) => category.id === route?.query.remove,
    );
    if (removing) {
      deleting.value = removing;
      targetId.value =
        props.categories.find((category) => category.id !== removing.id)?.id ??
        '';
    }
  },
  { immediate: true },
);
</script>
<template>
  <section class="record-panel">
    <h2>分类管理</h2>
    <p>最多 20 个，至少保留一个；删除分类会转移正常与回收站事项。</p>
    <ul class="category-list">
      <li v-for="category in categories" :key="category.id">
        <span :style="{ color: category.color }">●</span>
        {{ category.name }}（{{
          entries.filter((entry) => entry.categoryId === category.id).length
        }}
        条，含回收站）<button
          class="secondary"
          :disabled="busy"
          @click="start(category)"
        >
          改名 / 改色</button
        ><button
          class="secondary"
          :disabled="busy || categories.length <= 1"
          @click="
            deleting = category;
            targetId =
              categories.find((value) => value.id !== category.id)?.id ?? '';
          "
        >
          删除分类
        </button>
      </li>
    </ul>
    <button v-if="!creating" class="add-inline" @click="creating = true">
      <PlannerIcon name="plus" />添加分类
    </button>
    <form v-else @submit.prevent="save">
      <h3>{{ edit ? '修改分类' : '新建分类' }}</h3>
      <label>分类名称<input v-model="name" required :disabled="busy" /></label
      ><label
        >分类颜色<input v-model="color" type="color" :disabled="busy" /></label
      ><button :disabled="busy">{{ edit ? '保存分类修改' : '创建分类' }}</button
      ><button type="button" class="secondary" :disabled="busy" @click="reset">
        取消修改
      </button>
    </form>
    <div v-if="deleting" class="notice">
      <p>
        删除“{{ deleting.name }}”，并将
        {{
          entries.filter((entry) => entry.categoryId === deleting?.id).length
        }}
        条事项转入：
      </p>
      <select v-model="targetId" :disabled="busy">
        <option
          v-for="category in categories.filter(
            (value) => value.id !== deleting?.id,
          )"
          :key="category.id"
          :value="category.id"
        >
          {{ category.name }}
        </option></select
      ><button :disabled="busy || !targetId" @click="remove">
        确认转移并删除分类</button
      ><button class="secondary" :disabled="busy" @click="deleting = null">
        取消删除
      </button>
    </div>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
  </section>
</template>
