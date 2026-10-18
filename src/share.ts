/** 分享链接：带上 ?p=<slug>，对方打开首页就会自动弹出这个项目。 */
export function shareUrlFor(slug: string): string {
  const url = new URL(window.location.href);
  url.hash = '';
  url.search = '';
  url.searchParams.set('p', slug);
  return url.toString();
}

/** 复制文本：优先用剪贴板 API，非安全上下文（http 局域网）回退到临时 textarea。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到下面的兜底方案
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** 读取地址栏里的 ?p= 参数；解析失败或不合法时返回 null。 */
export function readDeepLinkSlug(): string | null {
  try {
    const slug = new URLSearchParams(window.location.search).get('p');
    if (!slug) return null;
    const trimmed = slug.trim();
    return /^[a-z0-9][a-z0-9-]{0,63}$/.test(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}
