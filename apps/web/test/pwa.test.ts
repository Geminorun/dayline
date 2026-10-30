import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPwaClient } from '../src/pwa/client';
import { canReload, registerReloadGuard } from '../src/pwa/reload-guards';
import { flushPromises } from '@vue/test-utils';
const disposers: (() => void)[] = [];
function setup(controlled = true) {
  const worker = Object.assign(new EventTarget(), {
    state: 'installing',
    postMessage: vi.fn(),
  });
  const registration = Object.assign(new EventTarget(), {
    active: controlled ? {} : null,
    waiting: null as typeof worker | null,
    installing: worker,
    update: vi.fn().mockResolvedValue(undefined),
  });
  const serviceWorker = Object.assign(new EventTarget(), {
    controller: controlled ? worker : null,
    register: vi.fn().mockResolvedValue(registration),
  });
  vi.stubGlobal('isSecureContext', true);
  vi.spyOn(window.document, 'readyState', 'get').mockReturnValue('complete');
  Object.defineProperty(navigator, 'serviceWorker', {
    value: serviceWorker,
    configurable: true,
  });
  const client = createPwaClient(window);
  disposers.push(() => client.dispose());
  client.start();
  return { client, worker, registration, serviceWorker };
}
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  Reflect.deleteProperty(navigator, 'serviceWorker');
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('PWA browser adapter', () => {
  it('registers only a same-origin worker without HTTP cache and waits for installation before claiming offline readiness', async () => {
    const { client, worker, serviceWorker } = setup(false);
    expect(client.state.offlineReady).toBe(false);
    await flushPromises();
    expect(serviceWorker.register).toHaveBeenCalledWith('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });
    worker.state = 'installed';
    worker.dispatchEvent(new Event('statechange'));
    expect(client.state.offlineReady).toBe(true);
    expect(client.state.updateAvailable).toBe(false);
  });
  it('prompts for new versions and never activates them without user action', async () => {
    const { client, worker, registration } = setup();
    await flushPromises();
    worker.state = 'installed';
    registration.waiting = worker;
    worker.dispatchEvent(new Event('statechange'));
    expect(client.state.updateAvailable).toBe(true);
    expect(worker.postMessage).not.toHaveBeenCalled();
    client.update();
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });
  it('allows retry when activation does not finish', async () => {
    vi.useFakeTimers();
    const { client, worker, registration } = setup();
    await flushPromises();
    worker.state = 'installed';
    registration.waiting = worker;
    worker.dispatchEvent(new Event('statechange'));
    client.update();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(client.state.updating).toBe(false);
    expect(client.state.failed).toBe(true);
    client.update();
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
  });
  it('keeps other tabs open when a new controller takes over', async () => {
    const { client, serviceWorker } = setup();
    await flushPromises();
    serviceWorker.dispatchEvent(new Event('controllerchange'));
    expect(client.state.updateAvailable).toBe(true);
    expect(client.state.updating).toBe(false);
  });
  it('captures installation only when supported and consumes each prompt once', async () => {
    const { client } = setup();
    const prompt = vi.fn().mockResolvedValue({ outcome: 'dismissed' });
    const event = Object.assign(
      new Event('beforeinstallprompt', { cancelable: true }),
      { prompt },
    );
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(client.state.installable).toBe(true);
    await client.install();
    expect(prompt).toHaveBeenCalledOnce();
    expect(client.state.installed).toBe(false);
    await client.install();
    expect(prompt).toHaveBeenCalledOnce();
    expect(client.state.installHelp).toBe(true);
    window.dispatchEvent(new Event('appinstalled'));
    expect(client.state.installed).toBe(true);
  });
  it('handles unsupported browsers and failed caching without blocking the application', async () => {
    const client = createPwaClient(window);
    disposers.push(client.dispose);
    client.start();
    await client.install();
    expect(client.state.installHelp).toBe(true);
    const { client: supported, serviceWorker } = setup(false);
    serviceWorker.register.mockRejectedValueOnce(
      new Error('network unavailable'),
    );
    // The initial resolved registration is safe; an explicit check failure is also non-fatal.
    await flushPromises();
    const second = createPwaClient(window);
    disposers.push(second.dispose);
    second.start();
    await flushPromises();
    expect(second.state.failed).toBe(true);
    expect(second.state.offlineReady).toBe(false);
    expect(supported.state.failed).toBe(false);
  });
  it('tracks offline state and avoids update network calls while offline', async () => {
    const { client, registration } = setup();
    await flushPromises();
    window.dispatchEvent(new Event('offline'));
    expect(client.state.offline).toBe(true);
    await client.checkUpdate(true);
    expect(registration.update).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('online'));
    await flushPromises();
    expect(client.state.offline).toBe(false);
    expect(registration.update).toHaveBeenCalledOnce();
  });
  it('awaits local draft persistence and respects cancelled reload guards', async () => {
    const guard = vi.fn().mockResolvedValue(false);
    const remove = registerReloadGuard(guard);
    try {
      expect(await canReload()).toBe(false);
    } finally {
      remove();
    }
    expect(await canReload()).toBe(true);
    let release: (value: boolean) => void = () => {};
    const detach = registerReloadGuard(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const decision = canReload();
    release(true);
    try {
      expect(await decision).toBe(true);
    } finally {
      detach();
    }
  });
});
