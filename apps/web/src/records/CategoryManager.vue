<script setup lang="ts">
import { computed, ref, inject, watch } from 'vue';
import { routeLocationKey } from 'vue-router';
import PlannerIcon from '../components/PlannerIcon.vue';
import IconButton from '../components/IconButton.vue';
import ColorPicker from '../components/ColorPicker.vue';
import { nextCategoryColor } from '@dayline/core';
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
const usedColors = computed(() => props.categories.map((c) => c.color));
const color = ref(nextCategoryColor(usedColors.value));
const saving = ref(false);
const locked = computed(() => props.busy || saving.value);
const edit = ref<CategoryDto | null>(null);
const error = ref('');
const newId = ref(crypto.randomUUID());
const deleting = ref<CategoryDto | null>(null);
const targetId = ref('');
function start(category: CategoryDto) {
  creating.value = false;
  deleting.value = null;
  edit.value = category;
  name.value = category.name;
  color.value = category.color;
  error.value = '';
}
function reset() {
  creating.value = false;
  edit.value = null;
  name.value = '';
  color.value = nextCategoryColor(usedColors.value);
  newId.value = crypto.randomUUID();
}
function begin() {
  deleting.value = null;
  reset();
  creating.value = true;
  error.value = '';
}
async function recolor(category: CategoryDto, value: string) {
  if (locked.value) return;
  await persist(category, category.name, value);
}
async function save() {
  if (locked.value) return;
  if (await persist(edit.value, name.value, color.value)) reset();
}
async function persist(
  current: CategoryDto | null,
  nextName: string,
  nextColor: string,
) {
  const input = createCategorySchema.safeParse({
    id: current?.id ?? newId.value,
    name: nextName,
    color: nextColor,
  });
  if (!input.success) {
    error.value = '名称须为 1–12 字，颜色为 #RRGGBB。';
    return false;
  }
  error.value = '';
  saving.value = true;
  try {
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
    return true;
  } catch (cause) {
    error.value = errorMessage(cause);
    return false;
  } finally {
    saving.value = false;
  }
}
async function remove() {
  if (locked.value) return;
  const source = deleting.value;
  const target = props.categories.find((value) => value.id === targetId.value);
  if (!source || !target) return;
  saving.value = true;
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
  } finally {
    saving.value = false;
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
  <section class="record-panel category-manager">
    <h2>分类管理</h2>
    <p>最多 20 个；删除分类时，记录会转移至你选择的分类。</p>
    <ul class="category-list">
      <li
        v-for="category in categories"
        :key="category.id"
        class="category-manager-row"
      >
        <span
          class="category-dot"
          :style="{ backgroundColor: category.color }"
        ></span>
        <form
          v-if="edit?.id === category.id"
          class="category-rename"
          @submit.prevent="save"
        >
          <input
            v-model="name"
            :aria-label="`重命名${category.name}`"
            required
            :disabled="locked"
            autofocus
          />
          <button
            type="submit"
            class="icon-btn tool-button"
            :disabled="locked"
            title="保存名称"
            aria-label="保存名称"
          >
            <PlannerIcon name="check" />
          </button>
          <IconButton
            icon="close"
            label="取消重命名"
            :disabled="locked"
            @click="reset"
          />
        </form>
        <template v-else>
          <div class="category-description">
            <strong>{{ category.name }}</strong
            ><small
              >{{
                entries.filter((entry) => entry.categoryId === category.id)
                  .length
              }}
              条记录</small
            >
          </div>
          <div class="row-tools">
            <IconButton
              icon="edit"
              :label="`重命名${category.name}`"
              :disabled="locked"
              @click="start(category)"
            />
            <ColorPicker
              :model-value="category.color"
              :label="`更改${category.name}颜色`"
              :used="usedColors.filter((c) => c !== category.color)"
              :disabled="locked"
              @update:model-value="recolor(category, $event)"
            />
            <IconButton
              icon="trash"
              :label="`删除${category.name}分类`"
              danger
              :disabled="locked || categories.length <= 1"
              @click="
                deleting = category;
                targetId =
                  categories.find((value) => value.id !== category.id)?.id ??
                  '';
                reset();
              "
            />
          </div>
        </template>
        <div
          v-if="deleting?.id === category.id"
          class="notice category-transfer"
        >
          <h3>删除“{{ deleting.name }}”？</h3>
          <p>
            {{
              entries.filter((entry) => entry.categoryId === deleting?.id)
                .length
            }}
            条记录（含回收站）将转入所选分类。
          </p>
          <label
            >转入分类<select v-model="targetId" :disabled="locked">
              <option
                v-for="category in categories.filter(
                  (value) => value.id !== deleting?.id,
                )"
                :key="category.id"
                :value="category.id"
              >
                {{ category.name }}
              </option>
            </select></label
          >
          <div class="action-bar">
            <button
              type="button"
              class="button danger"
              :disabled="locked || !targetId"
              @click="remove"
            >
              转移并删除分类</button
            ><button
              type="button"
              class="button subtle"
              :disabled="locked"
              @click="deleting = null"
            >
              取消
            </button>
          </div>
        </div>
      </li>
    </ul>
    <button
      v-if="!creating && !edit"
      type="button"
      class="button subtle category-add"
      :disabled="locked || categories.length >= 20"
      @click="begin"
    >
      <PlannerIcon name="plus" />添加分类
    </button>
    <form
      v-if="creating && !edit"
      class="category-create"
      @submit.prevent="save"
    >
      <label
        >分类名称<input
          v-model="name"
          required
          :disabled="locked"
          placeholder="新分类名称"
      /></label>
      <div class="category-create-actions">
        <ColorPicker
          v-model="color"
          label="选择新分类颜色"
          :used="usedColors"
          :disabled="locked"
        /><span class="category-dot" :style="{ backgroundColor: color }"></span>
        <button type="submit" class="button primary" :disabled="locked">
          创建分类
        </button>
        <IconButton
          icon="close"
          label="取消创建分类"
          :disabled="locked"
          @click="reset"
        />
      </div>
    </form>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
  </section>
</template>
