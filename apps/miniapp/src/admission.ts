import { ref } from 'vue';
import { AdmissionCoordinator } from '@dayline/api-client';
import type { AdmissionOperation, ImportJobDto } from '@dayline/contracts';
import { api } from './api';
import { localEnvironment, localRepository } from './adapters/local-repository';
import {
  MiniGuestRepository,
  platformStorage,
} from './adapters/guest-repository';
import { newId } from './adapters/uuid';
const guest = new MiniGuestRepository(
  platformStorage,
  () => {
    throw new Error('Read only');
  },
  `dayline:${import.meta.env.MODE}:${encodeURIComponent(import.meta.env.VITE_API_BASE_URL ?? 'unconfigured')}:v1:guest`,
);
const job = ref<ImportJobDto | null>(null),
  operation = ref<AdmissionOperation | null>(null),
  error = ref(''),
  busy = ref(false);
const coordinator = new AdmissionCoordinator(
  api,
  localEnvironment,
  localRepository,
  () => guest.read(),
  newId,
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
