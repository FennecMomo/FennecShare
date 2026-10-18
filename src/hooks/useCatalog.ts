import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicCatalogResponse } from '../../shared/types';
import { fetchCatalog } from '../api';

/** 刷新节流窗口：窗口重新聚焦或定时检查时，最多每 30 秒真的发一次请求。 */
const REFRESH_THROTTLE_MS = 30_000;

export interface CatalogState {
  status: 'loading' | 'ready' | 'error';
  data: PublicCatalogResponse | null;
  error: string | null;
}

export function useCatalog(): CatalogState & { reload: () => void } {
  const [state, setState] = useState<CatalogState>({ status: 'loading', data: null, error: null });
  const [reloadToken, setReloadToken] = useState(0);
  const lastLoadedAt = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void (async () => {
      try {
        const data = await fetchCatalog(controller.signal);
        if (!active) return;
        lastLoadedAt.current = Date.now();
        setState({ status: 'ready', data, error: null });
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        setState((previous) => ({
          status: 'error',
          data: previous.data,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [reloadToken]);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    const refreshIfStale = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (Date.now() - lastLoadedAt.current < REFRESH_THROTTLE_MS) return;
      reload();
    };
    const onFocus = () => refreshIfStale();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refreshIfStale();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [reload]);

  return { ...state, reload };
}
