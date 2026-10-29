<script setup lang="ts">
import { spanLabel, tr, messageRef } from '../../i18n/index';

import { msg } from '@dayline/locales';
import { computed, ref, watch } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import {
  createEntrySchema,
  focusRemovalDetailsSchema,
  GuestError,
  entryResultSchema,
} from '@dayline/contracts';
import type { EntryDto } from '@dayline/contracts';
import { ClientError } from '@dayline/api-client';

import { useWorkspace, records, message } from '../../workspace';
import { api } from '../../api';
import { newId } from '../../adapters/uuid';
const {
  mode,
  spaceRevision,
  snapshot,
  busy,
  error: workspaceError,
  readonly,
  ensure,
  mutate,
} = useWorkspace();
let editorSpace = -1,
  editorActor = -1;
const id = ref(''),
  entry = ref<EntryDto | null>(null),
  title = ref(''),
  start = ref(''),
  end = ref(''),
  categoryId = ref(''),
  error = messageRef(),
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
      error.value = msg('edit.theEntryDoesNotExistOrHas');
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
    editorSpace = spaceRevision.value;
    editorActor = api.getGeneration();
    ready.value = true;
  } catch (cause) {
    error.value = message(cause);
  }
});
watch(spaceRevision, () => {
  if (editorSpace >= 0 && editorSpace !== spaceRevision.value) {
    ready.value = false;
    error.value = msg('edit.theDataSpaceHasChangedPleaseEnter');
  }
});
function matches(
  value: EntryDto,
  input: ReturnType<typeof createEntrySchema.parse>,
) {
  return (
    !value.deletedAt &&
    value.title === input.title &&
    value.startDate === input.startDate &&
    value.endDate === input.endDate &&
    value.categoryId === input.categoryId
  );
}
async function save(confirm = false) {
  if (saving.value || busy.value || readonly.value) return;
  if (
    editorSpace !== spaceRevision.value ||
    editorActor !== api.getGeneration()
  ) {
    error.value = msg('edit.theDataSpaceHasChangedPleaseRe');
    return;
  }
  error.value = '';
  const parsed = createEntrySchema.safeParse({
    id: id.value,
    title: title.value,
    startDate: start.value,
    endDate: end.value || null,
    categoryId: categoryId.value,
  });
  if (!parsed.success) {
    error.value = msg('edit.pleaseCheckTitle1100WordsLegal');
    return;
  }
  if (parsed.data.endDate && parsed.data.endDate < parsed.data.startDate) {
    error.value = msg('errors.endDateCannotBeEarlierThanStart');
    return;
  }
  const requestEntry = entry.value ? { ...entry.value } : null,
    requestId = id.value,
    requestAck =
      confirm && ack.value ? ack.value.map((day) => ({ ...day })) : null;
  saving.value = true;
  try {
    let response: unknown;
    if (requestEntry) {
      const input = {
        expectedVersion: requestEntry.version,
        title: parsed.data.title,
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate,
        categoryId: parsed.data.categoryId,
        ...(requestAck ? { focusRemovalAcknowledgement: requestAck } : {}),
      };
      response = await mutate({ kind: 'update', id: requestId, input }, () =>
        records.update(requestId, input),
      );
    } else
      response = await mutate({ kind: 'create', input: parsed.data }, () =>
        records.create(parsed.data),
      );
    if (
      editorSpace !== spaceRevision.value ||
      editorActor !== api.getGeneration()
    )
      return;
    const result = entryResultSchema.safeParse(
      typeof response === 'object' && response !== null && 'data' in response
        ? response.data
        : undefined,
    );
    if (
      result.success &&
      result.data.alreadyExists &&
      !matches(result.data.entry, parsed.data)
    ) {
      error.value = msg('edit.theSameStableIdentifierAlreadyHasDifferent');
      return;
    }
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
    if (
      cause instanceof ClientError &&
      ['NETWORK_ERROR', 'INVALID_RESPONSE'].includes(cause.code) &&
      mode.value === 'account'
    ) {
      error.value = msg('entryEditor.theSavedResultsArePendingConfirmationAnd');
      try {
        const latest = await records.detail(requestId);
        if (
          editorSpace !== spaceRevision.value ||
          editorActor !== api.getGeneration()
        )
          return;
        if (
          latest.data &&
          matches(latest.data.entry, parsed.data) &&
          (!requestEntry || latest.data.entry.version > requestEntry.version)
        ) {
          error.value = msg('edit.verifiedThatTheCloudSaveWasSuccessful');
          entry.value = latest.data.entry;
          await useWorkspace().load();
          return;
        }
        error.value = msg('edit.theCurrentCloudHasBeenCheckedAnd');
      } catch {
        error.value = msg('edit.theSavedResultStillNeedsToBe');
      }
    } else error.value = message(cause);
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
    ><text class="title">{{
      entry ? tr('edit.entryDetailsEdit') : tr('common.newEntry2')
    }}</text
    ><text class="text muted">{{
      mode === 'guest'
        ? tr('edit.guestItWillBeConsideredSavedOnly')
        : tr('edit.onlineSavingTheCurrentInputIsOnly')
    }}</text
    ><text v-if="workspaceError" class="text error">{{ workspaceError }}</text
    ><view v-if="ready && snapshot" class="card"
      ><text class="text">{{
        tr('entryEditor.title100Words', { value0: [...title].length })
      }}</text
      ><input
        v-model="title"
        :maxlength="200"
        :aria-label="tr('common.entryTitle')"
        :disabled="saving || readonly"
        :placeholder="tr('edit.anExperienceWorthRecording')"
      /><text class="text">{{ tr('common.startDate') }}</text
      ><picker
        :disabled="saving || readonly"
        mode="date"
        :value="start"
        start="0001-01-01"
        end="9999-12-31"
        @change="start = $event.detail.value"
        ><view class="picker">{{ start }} ▾</view></picker
      ><input
        v-model="start"
        :disabled="saving || readonly"
        :aria-label="tr('edit.startDateYyyyMmDd')"
        placeholder="YYYY-MM-DD"
      /><text class="text">{{
        tr('entryEditor.endDateLeaveBlankToIndicateNot')
      }}</text
      ><picker
        :disabled="saving || readonly"
        mode="date"
        :value="end || today"
        start="0001-01-01"
        end="9999-12-31"
        @change="end = $event.detail.value"
        ><view class="picker"
          >{{ end || tr('common.notFinished') }} ▾</view
        ></picker
      ><input
        v-model="end"
        :disabled="saving || readonly"
        :aria-label="tr('edit.endDateYyyyMmDd')"
        :placeholder="tr('common.leaveBlankForOngoingEntries')"
      /><button class="secondary" :disabled="saving" @click="end = ''">
        {{ tr('common.clearEndDate') }}</button
      ><text class="text">{{ tr('common.category') }}</text
      ><picker
        :disabled="saving || readonly"
        :value="categoryIndex"
        :range="snapshot.categories.map((c) => c.name)"
        @change="
          categoryId =
            snapshot?.categories[Number($event.detail.value)]?.id ?? ''
        "
        ><view class="picker"
          >{{
            snapshot.categories[categoryIndex]?.name ??
            tr('common.pleaseSelectAValidCategory')
          }}
          ▾</view
        ></picker
      ><text v-if="entry" class="text muted">{{
        tr('edit.originalRecord', { value0: spanLabel(entry, today) })
      }}</text
      ><text v-if="error" class="text error" role="alert">{{ error }}</text
      ><view v-if="ack" class="notice"
        ><text class="text">{{
          tr('edit.focusDaysWillBeCancelled', { value0: ack.length })
        }}</text
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
          {{ tr('entryEditor.showMoreAffectedDates') }}</button
        ><button :disabled="saving || busy" @click="save(true)">
          {{ tr('entryEditor.confirmToRemoveTheseHighlightsAndSave') }}</button
        ><button
          class="secondary"
          :disabled="saving || busy"
          @click="ack = null"
        >
          {{ tr('common.cancelConfirmation') }}
        </button></view
      ><button :disabled="saving || busy || readonly" @click="save()">
        {{
          saving
            ? tr('common.saving')
            : mode === 'guest'
              ? tr('common.saveToLocalMachine')
              : tr('common.saveToCloud')
        }}</button
      ><button
        class="secondary"
        :disabled="saving || busy"
        @click="leave = true"
      >
        {{ tr('common.back') }}
      </button></view
    ><text v-if="error && !ready" class="text error">{{ error }}</text
    ><view v-if="entry" class="card"
      ><text class="heading">{{
        tr('timelineView.cumulativeFocusDays', { value0: focuses.length })
      }}</text
      ><scroll-view scroll-y class="dates-scroll"
        ><text class="text">{{
          focuses.join('、') || tr('common.noFocusYet')
        }}</text></scroll-view
      ><text class="text">{{
        tr('edit.specifyFocusDatesNotSavedWithThe')
      }}</text
      ><input
        v-model="focusDate"
        :aria-label="tr('edit.focusDatesYyyyMmDd')"
        placeholder="YYYY-MM-DD"
      /><button
        class="secondary"
        :disabled="busy || saving || readonly"
        @click="focus"
      >
        {{ tr('edit.setCancelHighlightsForTheDay') }}
      </button></view
    ><view v-if="leave" class="card confirmation"
      ><text class="text">{{ tr('edit.leavingWillDiscardUnsavedInput') }}</text
      ><button class="secondary" @click="leave = false">
        {{ tr('common.continueEditing') }}</button
      ><button @click="back">{{ tr('common.discardAndGoBack') }}</button></view
    ></view
  >
</template>
