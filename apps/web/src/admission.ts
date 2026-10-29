import { messageRef } from './i18n';
import { ref } from 'vue';
import { AdmissionCoordinator } from '@dayline/api-client';
import type { AdmissionOperation, ImportJobDto } from '@dayline/contracts';
import { api } from './api';
import { localEnvironment, localRepository } from './adapters/local-repository';
import { guestRepository } from './adapters/guest-repository';
const job = ref<ImportJobDto | null>(null),
  operation = ref<AdmissionOperation | null>(null),
  error = messageRef(),
  busy = ref(false);
const coordinator = new AdmissionCoordinator(
  api,
  localEnvironment,
  localRepository,
  () => guestRepository.read(),
  async () => crypto.randomUUID(),
  (state) => {
    job.value = state.job;
    operation.value = state.operation;
    error.value = state.error;
    busy.value = state.busy;
  },
);
export function useAdmission() {
  return {
    job,
    operation,
    error,
    busy,
    begin: coordinator.begin.bind(coordinator),
    action: coordinator.action.bind(coordinator),
  };
}
