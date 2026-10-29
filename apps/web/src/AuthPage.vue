<script setup lang="ts">
import { formatBeijingTime, tr, messageRef } from './i18n/index';

import { msg } from '@dayline/locales';
import PasswordInput from './components/PasswordInput.vue';

import {
  qrCreatedDtoSchema,
  qrStatusDtoSchema,
  nativeUserSchema,
  nativeStatusSchema,
  wechatLoginDtoSchema,
  nativeEmailFlowSchema,
  displayNameSchema,
} from '@dayline/contracts';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ClientError } from '@dayline/api-client';

import type { QrCreatedDto, EmailFlow } from '@dayline/contracts';

import { api } from './api';
import { useAccount } from './account';
import { useWorkspace } from './records/workspace';
import { takeAuthCallback } from './callback';
import { readAuthEmail, writeAuthEmail } from './auth-email';
const route = useRoute();
const router = useRouter();
const account = useAccount();
const mode = computed(() =>
  route.params.mode === 'verify-email' ? 'verify' : String(route.params.mode),
);
const titles: Record<string, string> = {
  get login() {
    return tr('common.signInToDayline');
  },
  get register() {
    return tr('common.createADaylineAccount');
  },
  get verify() {
    return tr('common.verifyEmail');
  },
  get verified() {
    return tr('common.emailVerification');
  },
  get 'forgot-password'() {
    return tr('common.resetYourPassword');
  },
  get 'reset-password'() {
    return tr('common.setANewPassword');
  },
  get 'change-password'() {
    return tr('common.changePassword');
  },
};
const callback = takeAuthCallback(window.location, window.history);
const savedEmail = readAuthEmail();
if (callback.email && callback.email !== savedEmail.email) {
  savedEmail.email = callback.email;
  savedEmail.retryUntil = 0;
  savedEmail.limited = false;
  delete savedEmail.flow;
  writeAuthEmail(savedEmail);
}
let resetToken: string | null = callback.token;
const name = ref('');
const email = ref(savedEmail.email);
const flow = ref<EmailFlow | undefined>(savedEmail.flow);
const registeredMessage = msg('auth.thisEmailAddressHasBeenRegisteredAnd');
const password = ref('');
const currentPassword = ref('');
const confirmPassword = ref('');
const busy = ref(false);
const message = messageRef(
  callback.error
    ? msg('auth.theLinkHasExpiredOrVerificationFailed')
    : mode.value === 'verified'
      ? msg('auth.ifYouHavePassedTheEmailLink')
      : mode.value === 'login' &&
          savedEmail.flow?.accountStatus === 'registered'
        ? registeredMessage
        : '',
);
const error = messageRef();
const rateLimited = ref(false);
const retrySeconds = ref(0);
const retryForLogin = ref(false);
const retryApplies = computed(
  () =>
    retrySeconds.value > 0 &&
    (retryForLogin.value
      ? mode.value === 'login'
      : ['register', 'verify', 'forgot-password'].includes(mode.value)),
);
const errorTip = computed(() =>
  rateLimited.value && retryApplies.value
    ? tr('errors.theOperationIsTooFrequentPleaseWait', {
        value0: retrySeconds.value,
      })
    : error.value,
);
const submitLabels: Record<string, string> = {
  get login() {
    return tr('common.signInWithEmail');
  },
  get register() {
    return tr('auth.signUpAndSendVerificationEmail');
  },
  get verify() {
    return tr('common.resendVerificationEmail');
  },
  get 'forgot-password'() {
    return tr('common.sendPasswordResetEmail');
  },
  get 'reset-password'() {
    return tr('common.resetPassword');
  },
  get 'change-password'() {
    return tr('common.changePassword');
  },
};
const submitLabel = computed(() => {
  if (busy.value) return tr('common.working');
  if (retryApplies.value)
    return tr('auth.secondsToRetry', { value0: retrySeconds.value });
  return submitLabels[mode.value] ?? tr('common.submit');
});
let retryTimer: ReturnType<typeof setInterval> | undefined;
function stopRetry() {
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = undefined;
  retrySeconds.value = 0;
  if (rateLimited.value) error.value = '';
  rateLimited.value = false;
}
function waitForRetry(
  seconds: number,
  limited = true,
  forLogin = mode.value === 'login',
) {
  stopRetry();
  if (seconds <= 0) return;
  rateLimited.value = limited;
  retryForLogin.value = forLogin;
  const until = Date.now() + seconds * 1000;
  writeAuthEmail({
    email: email.value.trim().toLowerCase(),
    retryUntil: until,
    limited,
    retryScope: forLogin ? 'login' : 'mail',
    ...(flow.value ? { flow: flow.value } : {}),
  });
  retrySeconds.value = seconds;
  retryTimer = setInterval(() => {
    retrySeconds.value = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    if (!retrySeconds.value) {
      const applicable = retryForLogin.value
        ? mode.value === 'login'
        : ['register', 'verify', 'forgot-password'].includes(mode.value);
      stopRetry();
      if (applicable && !message.value)
        message.value = msg('auth.theWaitIsOverAndYouCan');
    }
  }, 1000);
}
const unsubscribeRetry = api.onIdentityChange(stopRetry);
const qr = ref<QrCreatedDto | null>(null);
const qrBusy = ref(false);
const qrMessage = messageRef();
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let polling = false;
const isPassword = computed(() =>
  ['login', 'register', 'reset-password', 'change-password'].includes(
    mode.value,
  ),
);
const isEmail = computed(() =>
  ['login', 'register', 'verify', 'forgot-password'].includes(mode.value),
);
function mailFeedback(result: EmailFlow, startCooldown = true) {
  flow.value = result;
  if (result.mailStatus === 'accepted')
    message.value = msg('auth.theEmailHasBeenSubmittedForSending');
  else if (result.mailStatus === 'failed')
    error.value = msg('auth.theAccountIsStillRetainedAndThe');
  else if (result.mailStatus === 'unconfirmed')
    error.value = msg('auth.theEmailSendingResultHasNotBeen');
  else
    message.value =
      result.accountStatus === 'pending_verification'
        ? msg('auth.theEmailAddressHasNotBeenVerified')
        : msg('auth.thereIsNoVerificationEmailToSend');
  if (startCooldown) {
    writeAuthEmail({
      email: email.value.trim().toLowerCase(),
      flow: result,
      retryUntil: 0,
      limited: false,
    });
    waitForRetry(result.retryAfterSeconds, false, false);
  }
}
async function applyEmailFlow(result: EmailFlow) {
  // RouterView remounts auth pages by path. Persist guidance before navigating,
  // otherwise the result is written only into the disposed source page.
  writeAuthEmail({
    email: email.value.trim().toLowerCase(),
    flow: result,
    retryUntil: Date.now() + result.retryAfterSeconds * 1000,
    retryScope: 'mail',
    limited: false,
  });
  if (result.nextStep === 'login') {
    flow.value = undefined;
    stopRetry();
    await router.replace('/login');
    if (disposed) return;
    waitForRetry(result.retryAfterSeconds, false, false);
    message.value = registeredMessage;
    return;
  }
  await router.replace('/verify');
  if (disposed) return;
  mailFeedback(result);
}
async function requestVerification() {
  const generation = api.getGeneration();
  const callbackURL = new URL('/login', window.location.origin);
  callbackURL.searchParams.set('email', email.value.trim().toLowerCase());
  const result = await api.request('/api/auth/send-verification-email', {
    decode: nativeEmailFlowSchema.parse,
    method: 'POST',
    native: true,
    body: {
      email: email.value.trim().toLowerCase(),
      callbackURL: callbackURL.href,
    },
  });
  if (
    result.data &&
    !disposed &&
    mode.value === 'verify' &&
    generation === api.getGeneration()
  )
    await applyEmailFlow(result.data.emailFlow);
}
watch(mode, () => {
  error.value = '';
  message.value = '';
  password.value = '';
  currentPassword.value = '';
  confirmPassword.value = '';
});
onMounted(() => {
  if (mode.value === 'login' && flow.value?.accountStatus === 'registered') {
    flow.value = undefined;
    const { flow: previousFlow, ...remembered } = savedEmail;
    void previousFlow;
    writeAuthEmail(remembered);
  }
  if (mode.value === 'verify' && flow.value) mailFeedback(flow.value, false);
  const remaining = Math.max(
    0,
    Math.ceil((savedEmail.retryUntil - Date.now()) / 1000),
  );
  if (remaining) {
    waitForRetry(
      remaining,
      savedEmail.limited,
      savedEmail.retryScope === 'login',
    );
    if (savedEmail.limited)
      error.value = msg('auth.theOperationIsTooFrequentPleaseWait');
  }
  if (callback.error && ['login', 'verify'].includes(mode.value)) {
    message.value = '';
    error.value = msg('auth.theLinkHasExpiredOrVerificationFailed2');
  }
  if (mode.value === 'verified') {
    void router.replace('/login').then(() => {
      if (disposed) return;
      message.value = callback.error
        ? msg('auth.theLinkHasExpiredPleaseApplyFor')
        : msg('auth.theVerificationLinkHasBeenProcessedPlease');
    });
  }
});
watch(email, (next, previous) => {
  if (next.trim().toLowerCase() === previous.trim().toLowerCase()) return;
  stopRetry();
  flow.value = undefined;
  error.value = '';
  message.value = '';
});
function feedback(cause: unknown) {
  return cause instanceof ClientError
    ? (cause.localized ?? cause.message)
    : msg('auth.theOperationIsNotCompletedPleaseTry');
}
async function submit() {
  if (disposed || retryApplies.value) return;
  const submittedMode = mode.value;
  const generation = api.getGeneration();
  error.value = '';
  message.value = '';
  if (busy.value) return;
  if (
    mode.value === 'register' &&
    !displayNameSchema.safeParse(name.value).success
  ) {
    error.value = msg('errors.displayNameMustBe140Characters');
    return;
  }
  if (
    ['register', 'reset-password', 'change-password'].includes(mode.value) &&
    password.value !== confirmPassword.value
  ) {
    error.value = msg('auth.theNewPasswordsEnteredTwiceAreInconsistent');
    return;
  }
  busy.value = true;
  try {
    const loginCallback = new URL('/login', window.location.origin);
    loginCallback.searchParams.set('email', email.value.trim().toLowerCase());
    const callbackURL = loginCallback.href;
    const remembered = readAuthEmail();
    const submittedEmail = email.value.trim().toLowerCase();
    writeAuthEmail(
      remembered.email === submittedEmail
        ? remembered
        : {
            email: submittedEmail,
            retryUntil: 0,
            limited: false,
          },
    );
    if (mode.value === 'login') {
      await api.request('/api/auth/sign-in/email', {
        decode: nativeUserSchema.parse,
        method: 'POST',
        native: true,
        body: { email: email.value, password: password.value },
      });
      await account.refresh(true);
      account.announce();
      await useWorkspace().switchMode('account');
      await router.push(
        account.current.value?.status === 'pending_deletion' ||
          route.query.returnTo === '/account-deletion'
          ? '/account-deletion'
          : '/day',
      );
    } else if (mode.value === 'register') {
      const result = await api.request('/api/auth/sign-up/email', {
        decode: nativeEmailFlowSchema.parse,
        method: 'POST',
        native: true,
        body: {
          name: name.value.trim(),
          email: email.value.trim().toLowerCase(),
          password: password.value,
          callbackURL,
        },
      });
      if (
        result.data &&
        !disposed &&
        submittedMode === mode.value &&
        generation === api.getGeneration()
      )
        await applyEmailFlow(result.data.emailFlow);
    } else if (mode.value === 'verify') {
      await requestVerification();
    } else if (mode.value === 'forgot-password') {
      const result = await api.request('/api/auth/request-password-reset', {
        decode: nativeStatusSchema.parse,
        method: 'POST',
        native: true,
        body: {
          email: email.value,
          redirectTo: `${window.location.origin}/reset-password`,
        },
      });
      if (
        !disposed &&
        submittedMode === mode.value &&
        generation === api.getGeneration()
      ) {
        message.value = msg('auth.ifThisEmailAddressIsAlreadyRegistered');
        const retry = result.headers['retry-after'];
        if (retry && /^\d{1,5}$/.test(retry) && Number(retry) <= 86400)
          waitForRetry(Number(retry), false, false);
      }
    } else if (mode.value === 'reset-password') {
      if (!resetToken)
        throw new ClientError(
          'TOKEN_REQUIRED',
          msg('auth.missingValidResetLinkPleaseApplyAgain'),
        );
      await api.request('/api/auth/reset-password', {
        decode: nativeStatusSchema.parse,
        method: 'POST',
        native: true,
        body: { token: resetToken, newPassword: password.value },
      });
      resetToken = null;
      account.clear();
      await router.replace('/login');
      message.value = msg('auth.passwordHasBeenResetPleaseLogIn');
    } else if (mode.value === 'change-password') {
      if (!api.getAccount()) await account.refresh();
      await api.request('/api/auth/change-password', {
        decode: nativeUserSchema.parse,
        method: 'POST',
        native: true,
        account: true,
        body: {
          currentPassword: currentPassword.value,
          newPassword: password.value,
          revokeOtherSessions: true,
        },
      });
      await account.refresh();
      message.value = msg('auth.thePasswordHasBeenChangedAndThe');
    }
  } catch (cause) {
    if (
      disposed ||
      generation !== api.getGeneration() ||
      submittedMode !== mode.value
    )
      return;
    if (cause instanceof ClientError && cause.code === 'EMAIL_NOT_VERIFIED') {
      const remembered = readAuthEmail();
      await applyEmailFlow({
        nextStep: 'verify_email',
        accountStatus: 'pending_verification',
        mailStatus: 'not_sent',
        retryAfterSeconds: Math.max(
          0,
          Math.ceil((remembered.retryUntil - Date.now()) / 1000),
        ),
      });
      return;
    }
    error.value = feedback(cause);
    if (
      cause instanceof ClientError &&
      cause.status === 429 &&
      cause.retryAfterSeconds !== undefined
    )
      waitForRetry(cause.retryAfterSeconds);
  } finally {
    busy.value = false;
    password.value = '';
    currentPassword.value = '';
    confirmPassword.value = '';
  }
}
function stopPolling() {
  if (timer) clearTimeout(timer);
  timer = undefined;
}
async function poll() {
  const id = qr.value?.id;
  if (!id || disposed || polling) return;
  stopPolling();
  polling = true;
  try {
    const { data } = await api.request(`/api/v1/auth/qr-requests/${id}`, {
      decode: qrStatusDtoSchema.parse,
    });
    if (disposed || qr.value?.id !== id || !data) return;
    qr.value.status = data.status;
    if (data.status === 'confirmed') {
      qrMessage.value = msg('auth.wechatHasBeenConfirmedPleaseClickBelow');
      return;
    }
    if (['expired', 'cancelled', 'consumed'].includes(data.status)) {
      qrMessage.value =
        data.status === 'expired'
          ? msg('errors.theQrCodeHasExpiredPleaseRegenerate')
          : msg('auth.theQrCodeScanningRequestHasEnded');
      return;
    }
    qrMessage.value =
      data.status === 'scanned'
        ? msg('auth.scannedWaitingForConfirmationInTheApplet')
        : msg('auth.pleaseScanWithWechatAndConfirmThe');
    timer = setTimeout(() => {
      void poll();
    }, 2000);
  } catch (cause) {
    if (!disposed)
      qrMessage.value = msg('common.joinMessages', {
        value0: feedback(cause),
        value1: msg('auth.statusCanBeRefreshedManually'),
      });
  } finally {
    polling = false;
  }
}
async function cancelQr() {
  stopPolling();
  if (!qr.value) return;
  await api.request(`/api/v1/auth/qr-requests/${qr.value.id}`, {
    decode: qrStatusDtoSchema.parse,
    method: 'DELETE',
  });
  qr.value = null;
  qrMessage.value = msg('common.scanCodeRequestCanceled');
}
async function createQr() {
  if (qrBusy.value) return;
  qrBusy.value = true;
  error.value = '';
  try {
    if (
      qr.value &&
      !['consumed', 'expired', 'cancelled'].includes(qr.value.status)
    )
      await cancelQr();
    const { data } = await api.request('/api/v1/auth/qr-requests', {
      decode: qrCreatedDtoSchema.parse,
      method: 'POST',
      body: { id: crypto.randomUUID(), purpose: 'login' },
    });
    if (!disposed && data) {
      qr.value = data;
      await poll();
    }
  } catch (cause) {
    error.value = feedback(cause);
  } finally {
    qrBusy.value = false;
  }
}
async function consume() {
  if (!qr.value || qrBusy.value) return;
  qrBusy.value = true;
  try {
    await api.request(`/api/v1/auth/qr-requests/${qr.value.id}/consume`, {
      decode: wechatLoginDtoSchema.parse,
      method: 'POST',
    });
    await account.refresh(true);
    account.announce();
    await useWorkspace().switchMode('account');
    await router.push(
      account.current.value?.status === 'pending_deletion' ||
        route.query.returnTo === '/account-deletion'
        ? '/account-deletion'
        : '/day',
    );
  } catch (cause) {
    error.value = msg('common.joinMessages', {
      value0: feedback(cause),
      value1: msg('auth.pleaseGoToTheCurrentAccountPage'),
    });
  } finally {
    qrBusy.value = false;
  }
}
async function cancelSafely() {
  try {
    await cancelQr();
  } catch (cause) {
    error.value = feedback(cause);
  }
}
onBeforeUnmount(() => {
  disposed = true;
  stopRetry();
  unsubscribeRetry();
  stopPolling();
  resetToken = null;
  password.value = '';
  currentPassword.value = '';
});
</script>

<template>
  <section class="card auth-card" :aria-busy="busy">
    <h1>{{ titles[mode] ?? tr('common.account') }}</h1>
    <p v-if="mode === 'login'" class="auth-description">
      {{ tr('auth.onceLoggedInContinueYourRecordingOn') }}
    </p>
    <p v-else-if="mode === 'register'" class="auth-description">
      {{ tr('auth.createAnAccountAndStartSynchronizationAfter') }}
    </p>
    <nav
      v-if="['login', 'register'].includes(mode)"
      class="auth-tabs"
      :aria-label="tr('common.signInOrSignUp')"
    >
      <button
        class="auth-tab"
        type="button"
        :aria-pressed="mode === 'login'"
        :disabled="busy"
        @click="router.replace('/login')"
      >
        {{ tr('common.signIn') }}
      </button>
      <button
        class="auth-tab"
        type="button"
        :aria-pressed="mode === 'register'"
        :disabled="busy"
        @click="router.replace('/register')"
      >
        {{ tr('common.signUp') }}
      </button>
    </nav>
    <p v-if="mode === 'verify'" class="muted">
      {{ tr('auth.afterCompletingTheEmailVerificationYouCan') }}
    </p>
    <p
      v-if="mode === 'verify' && flow?.accountStatus === 'pending_verification'"
      class="notice"
    >
      {{ tr('auth.thisEmailAddressAlreadyHasAnAccount') }}
    </p>
    <p v-if="message" role="status" class="notice">{{ message }}</p>
    <p v-if="errorTip" role="alert" class="error">{{ errorTip }}</p>
    <p v-if="retryApplies" class="muted">
      {{ tr('auth.pleaseWaitForTheCountdownToEnd') }}
    </p>
    <form v-if="mode !== 'verified'" @submit.prevent="submit">
      <fieldset class="auth-fields" :disabled="busy">
        <label v-if="mode === 'register'"
          >{{ tr('common.displayName')
          }}<input
            v-model="name"
            name="name"
            autocomplete="nickname"
            maxlength="80"
            required
        /></label>
        <label v-if="isEmail"
          >{{ tr('common.email')
          }}<input
            v-model="email"
            name="email"
            type="email"
            autocomplete="email"
            required
        /></label>
        <label v-if="mode === 'change-password'"
          >{{ tr('common.currentPassword')
          }}<PasswordInput
            v-model="currentPassword"
            autocomplete="current-password"
            required
        /></label>
        <label v-if="isPassword"
          >{{
            mode === 'login'
              ? tr('common.password2')
              : tr('auth.newPassword8128Characters')
          }}<PasswordInput
            v-model="password"
            name="password"
            :autocomplete="
              mode === 'login' ? 'current-password' : 'new-password'
            "
            minlength="8"
            maxlength="128"
            required
        /></label>
        <label
          v-if="
            ['register', 'reset-password', 'change-password'].includes(mode)
          "
          >{{ tr('common.confirmNewPassword')
          }}<PasswordInput
            v-model="confirmPassword"
            autocomplete="new-password"
            minlength="8"
            maxlength="128"
            required
        /></label>
        <button
          class="button primary"
          type="submit"
          :disabled="busy || retryApplies"
        >
          {{ submitLabel }}
        </button>
      </fieldset>
    </form>
    <div class="links">
      <RouterLink v-if="mode === 'verify'" to="/login">{{
        tr('auth.emailVerifiedSignIn')
      }}</RouterLink>
      <RouterLink
        v-else-if="!['login', 'register'].includes(mode)"
        to="/login"
        >{{ tr('common.backToSignIn') }}</RouterLink
      >
      <RouterLink v-if="mode === 'verify'" to="/register">{{
        tr('auth.modifyEmailRegisterAccount')
      }}</RouterLink>
      <RouterLink v-if="mode === 'login'" to="/verify">{{
        tr('common.continueEmailVerification')
      }}</RouterLink>
      <RouterLink v-if="mode !== 'forgot-password'" to="/forgot-password">{{
        tr('common.forgotPassword')
      }}</RouterLink>
    </div>
    <section
      v-if="mode === 'login'"
      class="qr"
      :aria-label="tr('common.signInWithWechat2')"
    >
      <h2>{{ tr('common.signInWithWechat') }}</h2>
      <p>{{ tr('auth.pleaseConfirmClearlyInTheMiniProgram') }}</p>
      <button
        type="button"
        class="button subtle"
        :disabled="qrBusy"
        @click="createQr"
      >
        {{
          qrBusy
            ? tr('common.working')
            : qr
              ? tr('common.regenerateAppletCode')
              : tr('common.generateAppletCode')
        }}
      </button>
      <template v-if="qr"
        ><img
          :src="qr.miniappCode"
          :alt="tr('auth.miniProgramCodeUsedToConfirmThis')"
          width="240"
          height="240"
        />
        <p role="status">{{ qrMessage }}</p>
        <p>
          {{ tr('auth.expires', { value0: formatBeijingTime(qr.expiresAt) }) }}
        </p>
        <button
          class="button primary"
          v-if="qr.status === 'confirmed'"
          :disabled="qrBusy"
          @click="consume"
        >
          {{ tr('common.completeThisWebPageLogin') }}</button
        ><button
          v-else-if="['pending', 'scanned'].includes(qr.status)"
          class="button subtle"
          @click="poll"
        >
          {{ tr('common.refreshStatus') }}</button
        ><button
          v-if="['pending', 'scanned', 'confirmed'].includes(qr.status)"
          class="button subtle"
          @click="cancelSafely"
        >
          {{ tr('common.cancelThisQrCodeScan') }}
        </button></template
      >
    </section>
  </section>
</template>
