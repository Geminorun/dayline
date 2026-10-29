<script setup lang="ts">
import { tr, messageRef } from '../i18n/index';
import { msg } from '@dayline/locales';
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
  dataVersion: string;
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
const error = messageRef();
const newId = ref(crypto.randomUUID());
const deleting = ref<CategoryDto | null>(null);
const fallbackId = ref(crypto.randomUUID());
const deletionVersion = ref(''),
  deletionCount = ref(0);
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
    error.value = msg('categoryManager.nameMustBe112CharactersLong');
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
function confirmDelete(category: CategoryDto) {
  if (locked.value) return;
  deleting.value = category;
  error.value = '';
  deletionVersion.value = props.dataVersion;
  deletionCount.value = props.entries.filter(
    (entry) => entry.categoryId === category.id,
  ).length;
  fallbackId.value = crypto.randomUUID();
  reset();
}
async function remove() {
  if (locked.value) return;
  const source = deleting.value;
  if (!source) return;
  saving.value = true;
  error.value = '';
  try {
    const input = {
      expectedVersion: source.version,
      mode: 'trash' as const,
      expectedDataVersion: deletionVersion.value,
      fallbackCategoryId: fallbackId.value,
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
    if (
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      (cause.code === 'DATA_VERSION_CONFLICT' ||
        cause.code === 'VERSION_CONFLICT')
    )
      deleting.value = null;
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
    if (removing && deleting.value?.id !== removing.id) confirmDelete(removing);
  },
  { immediate: true },
);
</script>
<template>
  <section class="record-panel category-manager">
    <h2>{{ tr('common.categoryManagement') }}</h2>
    <p>{{ tr('categoryManager.maximum20AtLeastOneDragThe') }}</p>
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
            :aria-label="
              tr('categoryManager.rename', { value0: category.name })
            "
            required
            :disabled="locked"
            autofocus
          />
          <button
            type="submit"
            class="icon-btn tool-button"
            :disabled="locked"
            :title="tr('common.saveName')"
            :aria-label="tr('common.saveName')"
          >
            <PlannerIcon name="check" />
          </button>
          <IconButton
            icon="close"
            :label="tr('common.cancelRename')"
            :disabled="locked"
            @click="reset"
          />
        </form>
        <template v-else>
          <div class="category-description">
            <strong>{{ category.name }}</strong
            ><small>{{
              tr('categoryManager.records', {
                value0: entries.filter(
                  (entry) => entry.categoryId === category.id,
                ).length,
              })
            }}</small>
          </div>
          <div class="row-tools">
            <IconButton
              icon="edit"
              :label="tr('categoryManager.rename', { value0: category.name })"
              :disabled="locked"
              @click="start(category)"
            />
            <ColorPicker
              :model-value="category.color"
              :label="tr('data.changeColor', { value0: category.name })"
              :used="usedColors.filter((c) => c !== category.color)"
              :disabled="locked"
              @update:model-value="recolor(category, $event)"
            />
            <IconButton
              icon="trash"
              :label="
                tr('categoryManager.deleteCategory', { value0: category.name })
              "
              danger
              :disabled="locked || categories.length <= 1"
              @click="confirmDelete(category)"
            />
          </div>
        </template>
        <div
          v-if="deleting?.id === category.id"
          class="category-delete-confirm"
          role="group"
          :aria-label="
            tr('categoryManager.confirmDeletionOfCategory', {
              value0: category.name,
            })
          "
        >
          <p>
            {{ tr('common.thisCategoryHas')
            }}<strong>{{ deletionCount }}</strong
            >{{ tr('categoryManager.recordsAfterDeletingACategoryTheRecords') }}
          </p>
          <div class="action-bar">
            <button
              type="button"
              class="button danger"
              :disabled="locked"
              @click="remove"
            >
              {{ tr('common.deleteCategoriesAndRecords') }}</button
            ><button
              type="button"
              class="button subtle"
              :disabled="locked"
              @click="deleting = null"
            >
              {{ tr('common.cancel') }}
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
      <PlannerIcon name="plus" />{{ tr('common.addCategory') }}
    </button>
    <form
      v-if="creating && !edit"
      class="category-create"
      @submit.prevent="save"
    >
      <label
        >{{ tr('common.categoryName')
        }}<input
          v-model="name"
          required
          :disabled="locked"
          :placeholder="tr('common.newCategoryName')"
      /></label>
      <div class="category-create-actions">
        <ColorPicker
          v-model="color"
          :label="tr('common.selectNewCategoryColor')"
          :used="usedColors"
          :disabled="locked"
        /><span class="category-dot" :style="{ backgroundColor: color }"></span>
        <button type="submit" class="button primary" :disabled="locked">
          {{ tr('common.createACategory2') }}
        </button>
        <IconButton
          icon="close"
          :label="tr('common.cancelCreationOfCategory')"
          :disabled="locked"
          @click="reset"
        />
      </div>
    </form>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
  </section>
</template>
