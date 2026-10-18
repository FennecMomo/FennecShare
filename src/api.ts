import type { PublicCatalogResponse } from '../shared/types';

/** 前端只使用同源相对地址，不出现任何写死的域名、端口或 localhost。 */
export async function fetchCatalog(signal: AbortSignal): Promise<PublicCatalogResponse> {
  const response = await fetch('/api/projects', {
    signal,
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`项目列表接口返回 HTTP ${response.status}`);
  }
  return (await response.json()) as PublicCatalogResponse;
}
