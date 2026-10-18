/** 轻量埋点：只上报「试玩点击」「分享点击」，失败就静默忽略，绝不影响交互。 */
export type ClientStatType = 'play_click' | 'share_click';

export function reportStat(type: ClientStatType, slug: string, source: string): void {
  try {
    const body = JSON.stringify({ type, slug, source });
    void fetch('/api/stats/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // 埋点失败不影响任何交互
  }
}
