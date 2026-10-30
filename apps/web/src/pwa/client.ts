import { reactive, readonly } from 'vue';

interface InstallPrompt extends Event {
  prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
export function createPwaClient(browser: Window) {
  const standalone = () =>
    browser.matchMedia?.('(display-mode: standalone)').matches === true ||
    ('standalone' in browser.navigator &&
      browser.navigator.standalone === true);
  const state = reactive({
    installed: standalone(),
    installable: false,
    offline: !browser.navigator.onLine,
    offlineReady: false,
    updateAvailable: false,
    updating: false,
    failed: false,
    installHelp: false,
    updateHelp: false,
    checked: false,
    checking: false,
  });
  let prompt: InstallPrompt | undefined;
  let registration: ServiceWorkerRegistration | undefined;
  let reloadRequested = false;
  let started = false;
  let wasControlled = false;
  let updateTimer: ReturnType<typeof setTimeout> | undefined;
  const cleanups: (() => void)[] = [];
  function listen(target: EventTarget, type: string, action: EventListener) {
    target.addEventListener(type, action);
    cleanups.push(() => target.removeEventListener(type, action));
  }
  function watchWorker(worker: ServiceWorker | null) {
    if (!worker) return;
    let installed = false;
    const changed = () => {
      if (worker.state === 'installed') {
        installed = true;
        if (browser.navigator.serviceWorker.controller)
          state.updateAvailable = true;
        else state.offlineReady = true;
      }
      if (worker.state === 'redundant' && !installed) {
        state.updating = false;
        state.failed = true;
      }
    };
    listen(worker, 'statechange', changed);
    changed();
  }
  async function register() {
    try {
      registration = await browser.navigator.serviceWorker.register('/sw.js', {
        scope: '/',
        updateViaCache: 'none',
      });
      state.offlineReady = !!registration.active;
      state.updateAvailable = !!registration.waiting;
      listen(registration, 'updatefound', () =>
        watchWorker(registration?.installing ?? null),
      );
      watchWorker(registration.installing);
    } catch {
      state.failed = true;
    }
  }
  function start() {
    if (started) return;
    started = true;
    listen(browser, 'beforeinstallprompt', (event) => {
      if (!('prompt' in event) || typeof event.prompt !== 'function') return;
      event.preventDefault();
      // Narrow a browser-specific event at the platform boundary.
      prompt = event as InstallPrompt;
      state.installable = true;
    });
    listen(browser, 'appinstalled', () => {
      state.installHelp = false;
      state.installed = true;
      state.installable = false;
      prompt = undefined;
    });
    listen(browser, 'offline', () => {
      state.offline = true;
    });
    listen(browser, 'online', () => {
      state.offline = false;
      void checkUpdate();
    });
    if (!('serviceWorker' in browser.navigator) || !browser.isSecureContext)
      return;
    wasControlled = !!browser.navigator.serviceWorker.controller;
    state.offlineReady = wasControlled;
    listen(browser.navigator.serviceWorker, 'controllerchange', () => {
      if (reloadRequested) {
        clearTimeout(updateTimer);
        browser.location.reload();
      } else if (wasControlled) state.updateAvailable = true;
      wasControlled = true;
      state.offlineReady = true;
    });
    listen(browser.document, 'visibilitychange', () => {
      if (browser.document.visibilityState === 'visible') void checkUpdate();
    });
    if (browser.document.readyState === 'complete') void register();
    else
      listen(browser, 'load', () => {
        void register();
      });
  }
  let lastChecked = 0;
  async function checkUpdate(force = false) {
    if (
      !registration ||
      state.offline ||
      (!force && Date.now() - lastChecked < 60_000)
    )
      return;
    lastChecked = Date.now();
    state.checking = true;
    state.checked = false;
    try {
      await registration.update();
      state.failed = false;
      state.checked = !registration.installing;
    } catch {
      state.failed = true;
    } finally {
      state.checking = false;
    }
  }
  async function install() {
    if (!prompt) {
      state.installHelp = true;
      return;
    }
    const captured = prompt;
    prompt = undefined;
    state.installable = false;
    try {
      await captured.prompt();
    } catch {
      state.installHelp = true;
    }
  }
  function update() {
    if (!state.updateAvailable || state.updating || state.offline) return;
    state.updating = true;
    state.failed = false;
    reloadRequested = true;
    updateTimer = setTimeout(() => {
      reloadRequested = false;
      state.updating = false;
      state.failed = true;
    }, 15_000);
    if (registration?.waiting)
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    else browser.location.reload(); // Another tab has already activated the update.
  }
  function dispose() {
    clearTimeout(updateTimer);
    for (const cleanup of cleanups.splice(0)) cleanup();
  }
  return {
    state: readonly(state),
    start,
    install,
    update,
    checkUpdate,
    dispose,
    showUpdateHelp(value: boolean) {
      state.updateHelp = value;
    },
    showInstallHelp(value: boolean) {
      state.installHelp = value;
    },
  };
}
export const pwa = createPwaClient(window);
