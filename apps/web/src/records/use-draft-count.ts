import { liveQuery } from 'dexie';
import { computed, onBeforeUnmount, readonly, ref, watch } from 'vue';
import { useAccount } from '../account';
import { useWorkspace } from './workspace';
import { localRepository } from '../adapters/local-repository';
export function useDraftCount() {
  const count = ref(0),
    unavailable = ref(false),
    workspace = useWorkspace(),
    account = useAccount();
  const owner = computed(() =>
    workspace.mode.value === 'account' &&
    workspace.identityState.value === 'verified'
      ? (account.current.value?.id ?? null)
      : null,
  );
  let unsubscribe: (() => void) | undefined;
  const stop = watch(
    owner,
    (userId) => {
      unsubscribe?.();
      count.value = 0;
      unavailable.value = false;
      if (!userId) return;
      const subscription = liveQuery(() =>
        localRepository.drafts(userId),
      ).subscribe({
        next(drafts) {
          if (owner.value === userId) {
            count.value = drafts.length;
            unavailable.value = false;
          }
        },
        error() {
          if (owner.value === userId) {
            count.value = 0;
            unavailable.value = true;
          }
        },
      });
      unsubscribe = () => subscription.unsubscribe();
    },
    { immediate: true, flush: 'sync' },
  );
  onBeforeUnmount(() => {
    stop();
    unsubscribe?.();
  });
  return { count: readonly(count), unavailable: readonly(unavailable) };
}
