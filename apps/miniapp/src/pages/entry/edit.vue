<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import {
  createEntrySchema,
  focusRemovalDetailsSchema,
  GuestError,
} from '@dayline/contracts';
import type { EntryDto } from '@dayline/contracts';
import { ClientError } from '@dayline/api-client';
import { spanLabel } from '@dayline/core';
import { useWorkspace, records, message } from '../../workspace';
import { newId } from '../../adapters/uuid';
const {
  mode,
  snapshot,
  busy,
  error: workspaceError,
  readonly,
  ensure,
  mutate,
} = useWorkspace();
const id = ref(''),
  entry = ref<EntryDto | null>(null),
  title = ref(''),
  start = ref(''),
  end = ref(''),
  categoryId = ref(''),
  error = ref(''),
  saving = ref(false),
  ready = ref(false),
  leave = ref(false),
  ack = ref<{ date: string; version: number }[] | null>(null),
  focusDate = ref('');
const acknowledgementLimit = ref(100);
const today = computed(() => snapshot.value?.businessToday ?? '');
const categoryIndex = computed(
  () =>
    snapshot.value?.categories.findIndex((c) => c.id === categoryId.value) ??
    -1,
);
const focuses = computed(
  () =>
    snapshot.value?.focusDays
      .filter((f) => f.entryId === id.value && f.focused)
      .map((f) => f.date) ?? [],
);
watch([title, start, end, categoryId], () => (ack.value = null));
onLoad(async (query) => {
  await ensure();
  try {
    if (!snapshot.value) throw new Error('Data unavailable');
    const editing = typeof query?.id === 'string' ? query.id : null;
    const found = editing
      ? snapshot.value.entries.find((e) => e.id === editing)
      : null;
    if (editing && !found) {
      error.value = '事项不存在或已进入回收站。';
      return;
    }
    entry.value = found ? { ...found } : null;
    id.value = found?.id ?? (await newId());
    title.value = found?.title ?? '';
    start.value = found?.startDate ?? today.value;
    end.value = found?.endDate ?? '';
    categoryId.value =
      found?.categoryId ?? snapshot.value.categories[0]?.id ?? '';
    focusDate.value = today.value;
    ready.value = true;
  } catch (cause) {
    error.value = message(cause);
  }
});
async function save(confirm = false) {
  if (saving.value || busy.value || readonly.value) return;
  error.value = '';
  const parsed = createEntrySchema.safeParse({
    id: id.value,
    title: title.value,
    startDate: start.value,
    endDate: end.value || null,
    categoryId: categoryId.value,
  });
  if (!parsed.success) {
    error.value = '请检查标题（1–100 字）、合法日期与分类。';
    return;
  }
  if (parsed.data.endDate && parsed.data.endDate < parsed.data.startDate) {
    error.value = '结束日期不能早于开始日期。';
    return;
  }
  saving.value = true;
  try {
    if (entry.value) {
      const input = {
        expectedVersion: entry.value.version,
        title: parsed.data.title,
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate,
        categoryId: parsed.data.categoryId,
        ...(confirm && ack.value
          ? { focusRemovalAcknowledgement: ack.value }
          : {}),
      };
      await mutate({ kind: 'update', id: id.value, input }, () =>
        records.update(id.value, input),
      );
    } else
      await mutate({ kind: 'create', input: parsed.data }, () =>
        records.create(parsed.data),
      );
    uni.navigateBack({
      fail: () => uni.switchTab({ url: '/pages/entries/index' }),
    });
  } catch (cause) {
    if (
      (cause instanceof ClientError || cause instanceof GuestError) &&
      cause.code === 'FOCUS_REMOVAL_CONFIRMATION_REQUIRED'
    ) {
      const details = focusRemovalDetailsSchema.safeParse(cause.details);
      ack.value = details.success ? details.data.affectedFocusDays : null;
    }
    error.value = message(cause);
  } finally {
    saving.value = false;
  }
}
async function focus() {
  if (!entry.value) return;
  error.value = '';
  const existing = snapshot.value?.focusDays.find(
      (f) => f.entryId === id.value && f.date === focusDate.value,
    ),
    input = {
      focused: !existing?.focused,
      expectedEntryVersion: entry.value.version,
      expectedFocusVersion: existing?.version ?? 0,
    };
  try {
    await mutate(
      { kind: 'focus', id: id.value, date: focusDate.value, input },
      () => records.focus(id.value, focusDate.value, input),
    );
  } catch (cause) {
    error.value = message(cause);
  }
}
function back() {
  uni.navigateBack({
    fail: () => uni.switchTab({ url: '/pages/entries/index' }),
  });
}
</script>
<template>
  <view class="page"
    ><text class="title">{{ entry ? '事项详情 / 编辑' : '新建事项' }}</text
    ><text class="text muted">{{
      mode === 'guest'
        ? '游客 · 保存到本机成功后才算已保存。'
        : '在线保存 · 当前输入仅留在内存，离开前请手动提交。'
    }}</text
    ><text v-if="workspaceError" class="text error">{{ workspaceError }}</text
    ><view v-if="ready && snapshot" class="card"
      ><text class="text">标题（{{ [...title].length }} / 100 字）</text
      ><input
        v-model="title"
        aria-label="事项标题"
        :disabled="saving || readonly"
        placeholder="一段值得记录的经历"
      /><text class="text">开始日期</text
      ><picker
        mode="date"
        :value="start"
        start="0001-01-01"
        end="9999-12-31"
        @change="start = $event.detail.value"
        ><view class="picker">{{ start }} ▾</view></picker
      ><input
        v-model="start"
        aria-label="开始日期 YYYY-MM-DD"
        placeholder="YYYY-MM-DD"
      /><text class="text">结束日期（留空表示未结束）</text
      ><picker
        mode="date"
        :value="end || today"
        start="0001-01-01"
        end="9999-12-31"
        @change="end = $event.detail.value"
        ><view class="picker">{{ end || '未结束' }} ▾</view></picker
      ><input
        v-model="end"
        aria-label="结束日期 YYYY-MM-DD"
        placeholder="留空表示未结束"
      /><button class="secondary" :disabled="saving" @click="end = ''">
        清空结束日期</button
      ><text class="text">分类</text
      ><picker
        :value="categoryIndex"
        :range="snapshot.categories.map((c) => c.name)"
        @change="
          categoryId =
            snapshot?.categories[Number($event.detail.value)]?.id ?? ''
        "
        ><view class="picker"
          >{{
            snapshot.categories[categoryIndex]?.name ?? '请选择有效分类'
          }}
          ▾</view
        ></picker
      ><text v-if="entry" class="text muted"
        >原记录：{{ spanLabel(entry, today) }}</text
      ><text v-if="error" class="text error" role="alert">{{ error }}</text
      ><view v-if="ack" class="notice"
        ><text class="text">将取消 {{ ack.length }} 个重点日：</text
        ><scroll-view scroll-y class="dates-scroll"
          ><text
            v-for="day in ack.slice(0, acknowledgementLimit)"
            :key="day.date"
            class="text"
            >{{ day.date }}</text
          ></scroll-view
        ><button
          v-if="ack.length > acknowledgementLimit"
          class="secondary"
          @click="acknowledgementLimit += 100"
        >
          显示更多受影响日期</button
        ><button :disabled="saving || busy" @click="save(true)">
          确认移除这些重点并保存</button
        ><button
          class="secondary"
          :disabled="saving || busy"
          @click="ack = null"
        >
          取消确认
        </button></view
      ><button :disabled="saving || busy || readonly" @click="save()">
        {{
          saving ? '正在保存…' : mode === 'guest' ? '保存到本机' : '保存到云端'
        }}</button
      ><button
        class="secondary"
        :disabled="saving || busy"
        @click="leave = true"
      >
        返回
      </button></view
    ><text v-if="error && !ready" class="text error">{{ error }}</text
    ><view v-if="entry" class="card"
      ><text class="heading">累计重点 {{ focuses.length }} 天</text
      ><scroll-view scroll-y class="dates-scroll"
        ><text class="text">{{
          focuses.join('、') || '尚无重点'
        }}</text></scroll-view
      ><text class="text">指定重点日期（不随事项表单一起保存）</text
      ><input
        v-model="focusDate"
        aria-label="重点日期 YYYY-MM-DD"
        placeholder="YYYY-MM-DD"
      /><button
        class="secondary"
        :disabled="busy || saving || readonly"
        @click="focus"
      >
        设置 / 取消该日重点
      </button></view
    ><view v-if="leave" class="card confirmation"
      ><text class="text">离开将放弃尚未保存的输入。</text
      ><button class="secondary" @click="leave = false">继续编辑</button
      ><button @click="back">放弃并返回</button></view
    ></view
  >
</template>
