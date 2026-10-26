interface CallbackHistory {
  readonly state?: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}
/** Consume URL secrets into volatile memory before any component starts requests. */
export function takeAuthCallback(
  location: Pick<Location, 'href'>,
  history: CallbackHistory,
) {
  const url = new URL(location.href);
  const token = url.searchParams.get('token');
  const error = url.searchParams.get('error');
  if (url.search) {
    const state = history.state;
    const navigationState =
      state && typeof state === 'object' && !Array.isArray(state)
        ? ({ ...state } as Record<string, unknown>)
        : null;
    if (navigationState) {
      for (const key of ['current', 'back', 'forward']) {
        const value = navigationState[key];
        if (typeof value !== 'string') continue;
        try {
          const target = new URL(value, url.origin);
          target.searchParams.delete('token');
          target.searchParams.delete('error');
          navigationState[key] =
            target.origin === url.origin
              ? target.pathname + target.search + target.hash
              : target.href;
        } catch {
          navigationState[key] = null;
        }
      }
      navigationState.current = url.pathname + url.hash;
    }
    history.replaceState(navigationState, '', url.pathname + url.hash);
  }
  return { token, error };
}
