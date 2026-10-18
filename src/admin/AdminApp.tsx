import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface AdminProject {
  slug: string;
  title: string;
  summary: string;
  description: string;
  categories: string[];
  demo: boolean;
  sortOrder: number;
  displayVersion: string | null;
  published: boolean;
  unpublishReason: string | null;
  publishedAt: string | null;
  updatedAt: string;
  cover: { url: string; alt: string; releaseId: string; fileName: string } | null;
  screenshots: Array<{ url: string; alt: string; releaseId: string; fileName: string }>;
  web: { entry: string; publicUrl: string } | null;
  downloads: Array<{ fileName: string; platform: string; version: string | null; size: number; publicUrl: string }>;
  releaseCount: number;
}

interface SessionInfo {
  authenticated: boolean;
  passwordConfigured: boolean;
  passwordUpdatedAt: string | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  web: '网页',
  desktop: '桌面应用',
  mobile: '手机 APP',
};

const CATEGORY_KEYS = ['web', 'desktop', 'mobile'];

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-fennec-admin', '1');
  if (typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(response.status, error?.code ?? 'request_failed', error?.message ?? `请求失败（${response.status}）`);
  }
  return payload as T;
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export default function AdminApp() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [revision, setRevision] = useState<number | null>(null);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  const [showPasswordPanel, setShowPasswordPanel] = useState(false);

  const activeProject = useMemo(
    () => projects.find((project) => project.slug === activeSlug) ?? null,
    [activeSlug, projects],
  );

  const showToast = useCallback((text: string) => setToast({ text, id: Date.now() }), []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const loadSession = useCallback(async () => {
    try {
      const info = await api<SessionInfo>('/api/admin/session');
      setSession(info);
      setSessionError(null);
      return info;
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
      return null;
    }
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const data = await api<{ revision: number; projects: AdminProject[] }>('/api/admin/projects');
      setProjects(data.projects);
      setRevision(data.revision);
      setListError(null);
      setActiveSlug((previous) => {
        if (previous && data.projects.some((project) => project.slug === previous)) return previous;
        return data.projects[0]?.slug ?? null;
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSession({ authenticated: false, passwordConfigured: true, passwordUpdatedAt: null });
        return;
      }
      setListError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void loadSession().then((info) => {
      if (info?.authenticated) void loadProjects();
    });
  }, [loadProjects, loadSession]);

  const handleLogin = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setLoginBusy(true);
      setLoginError(null);
      try {
        await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
        setPassword('');
        const info = await loadSession();
        if (info?.authenticated) await loadProjects();
      } catch (error) {
        setLoginError(error instanceof Error ? error.message : String(error));
      } finally {
        setLoginBusy(false);
      }
    },
    [loadProjects, loadSession, password],
  );

  const handleLogout = useCallback(async () => {
    await api('/api/admin/logout', { method: 'POST' }).catch(() => undefined);
    setSession({ authenticated: false, passwordConfigured: true, passwordUpdatedAt: null });
    setProjects([]);
    setActiveSlug(null);
  }, []);

  if (sessionError) {
    return (
      <Shell>
        <div className="admin-card">
          <h1>管理页面暂时不可用</h1>
          <p className="muted">{sessionError}</p>
          <button type="button" className="btn primary" onClick={() => void loadSession()}>
            重试
          </button>
        </div>
      </Shell>
    );
  }

  if (!session) {
    return (
      <Shell>
        <p className="muted">正在检查登录状态…</p>
      </Shell>
    );
  }

  if (!session.authenticated) {
    return (
      <Shell>
        <form className="admin-card login-card" onSubmit={handleLogin}>
          <img src="/favicon.svg" alt="" width={48} height={48} />
          <h1>Fennec Share 管理</h1>
          <p className="muted">请输入管理密码。密码只保存在服务器上，忘记后需要在服务器用命令行重设。</p>
          {!session.passwordConfigured ? (
            <p className="warn">管理密码尚未初始化，请先在服务器上运行管理员命令设置密码。</p>
          ) : null}
          <label className="field">
            <span>密码</span>
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="请输入管理密码"
              autoFocus
            />
          </label>
          {loginError ? <p className="error">{loginError}</p> : null}
          <button type="submit" className="btn primary wide" disabled={loginBusy || password.length === 0}>
            {loginBusy ? '登录中…' : '登录'}
          </button>
        </form>
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="admin-topbar">
        <div className="admin-brand">
          <img src="/favicon.svg" alt="" width={34} height={34} />
          <div>
            <strong>Fennec Share 管理</strong>
            <span className="muted small">
              catalog revision {revision ?? '—'} · {projects.length} 个项目
            </span>
          </div>
        </div>
        <div className="admin-actions">
          <a className="btn subtle" href="/" target="_blank" rel="noopener noreferrer">
            查看站点
          </a>
          <button type="button" className="btn subtle" onClick={() => setShowPasswordPanel(true)}>
            修改密码
          </button>
          <button type="button" className="btn subtle" onClick={() => void handleLogout()}>
            退出登录
          </button>
        </div>
      </header>

      {listError ? <p className="error">{listError}</p> : null}

      <div className="admin-layout">
        <aside className="admin-list" aria-label="项目列表">
          {projects.map((project) => (
            <button
              key={project.slug}
              type="button"
              className={project.slug === activeSlug ? 'admin-list-item active' : 'admin-list-item'}
              onClick={() => setActiveSlug(project.slug)}
            >
              <span className="thumb">
                {project.cover ? <img src={project.cover.url} alt="" loading="lazy" /> : <span className="thumb-empty">无图</span>}
              </span>
              <span className="list-text">
                <strong>{project.title}</strong>
                <span className="muted small">{project.slug}</span>
              </span>
              <span className={project.published ? 'pill ok' : 'pill off'}>{project.published ? '已上架' : '已下架'}</span>
            </button>
          ))}
          {projects.length === 0 ? <p className="muted">还没有项目。</p> : null}
        </aside>

        <main className="admin-editor">
          {activeProject ? (
            <ProjectEditor
              key={activeProject.slug}
              project={activeProject}
              onChanged={async (message) => {
                showToast(message);
                await loadProjects();
              }}
              onError={(message) => showToast(message)}
            />
          ) : (
            <p className="muted">从左边选一个项目开始编辑。</p>
          )}
        </main>
      </div>

      {showPasswordPanel ? (
        <PasswordPanel
          onClose={() => setShowPasswordPanel(false)}
          onDone={(message) => {
            setShowPasswordPanel(false);
            showToast(message);
          }}
        />
      ) : null}

      {toast ? (
        <div className="admin-toast" role="status" key={toast.id}>
          {toast.text}
        </div>
      ) : null}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="admin-shell">
      <div className="admin-inner">{children}</div>
    </div>
  );
}

interface EditorProps {
  project: AdminProject;
  onChanged: (message: string) => Promise<void> | void;
  onError: (message: string) => void;
}

function ProjectEditor({ project, onChanged, onError }: EditorProps) {
  const [title, setTitle] = useState(project.title);
  const [summary, setSummary] = useState(project.summary);
  const [description, setDescription] = useState(project.description);
  const [categories, setCategories] = useState<string[]>(project.categories);
  const [sortOrder, setSortOrder] = useState(String(project.sortOrder));
  const [displayVersion, setDisplayVersion] = useState(project.displayVersion ?? '');
  const [demo, setDemo] = useState(project.demo);
  const [published, setPublished] = useState(project.published);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<'cover' | 'shots' | null>(null);
  const coverInput = useRef<HTMLInputElement | null>(null);
  const shotsInput = useRef<HTMLInputElement | null>(null);

  const toggleCategory = (category: string) => {
    setCategories((previous) =>
      previous.includes(category) ? previous.filter((item) => item !== category) : [...previous, category],
    );
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const result = await api<{ message: string }>(`/api/admin/projects/${project.slug}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title,
          summary,
          description,
          categories,
          sortOrder: Number(sortOrder),
          displayVersion: displayVersion.trim() === '' ? null : displayVersion,
          demo,
          published,
        }),
      });
      await onChanged(result.message);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const upload = async (kind: 'cover' | 'shots', file: File | undefined) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      onError('只支持 PNG / JPEG / WebP 图片');
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      onError('图片过大，上限 12 MiB');
      return;
    }
    setUploading(kind);
    try {
      const buffer = await file.arrayBuffer();
      const path =
        kind === 'cover'
          ? `/api/admin/projects/${project.slug}/cover`
          : `/api/admin/projects/${project.slug}/screenshots`;
      const result = await api<{ message: string }>(path, {
        method: kind === 'cover' ? 'PUT' : 'POST',
        headers: { 'Content-Type': file.type },
        body: buffer,
      });
      await onChanged(result.message);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(null);
      if (coverInput.current) coverInput.current.value = '';
      if (shotsInput.current) shotsInput.current.value = '';
    }
  };

  const removeCover = async () => {
    if (!window.confirm('确定移除这个项目的封面吗？')) return;
    try {
      const result = await api<{ message: string }>(`/api/admin/projects/${project.slug}/cover`, { method: 'DELETE' });
      await onChanged(result.message);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  const removeShot = async (index: number) => {
    if (!window.confirm('确定删除这张截图吗？')) return;
    try {
      const result = await api<{ message: string }>(`/api/admin/projects/${project.slug}/screenshots/${index}`, {
        method: 'DELETE',
      });
      await onChanged(result.message);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="editor-stack">
      <div className="editor-head">
        <div>
          <h2>{project.title}</h2>
          <p className="muted small">
            {project.slug} · 更新于 {formatTime(project.updatedAt)} · {project.releaseCount} 个历史版本
          </p>
        </div>
        <div className="editor-links">
          {project.web ? (
            <a className="btn subtle" href={project.web.publicUrl} target="_blank" rel="noopener noreferrer">
              在线体验
            </a>
          ) : null}
          <span className={project.published ? 'pill ok' : 'pill off'}>{project.published ? '已上架' : '已下架'}</span>
        </div>
      </div>

      <form className="editor-card" onSubmit={save}>
        <h3>基本信息</h3>
        <label className="field">
          <span>标题</span>
          <input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="field">
          <span>卡片简介</span>
          <textarea rows={3} value={summary} maxLength={400} onChange={(event) => setSummary(event.target.value)} />
        </label>
        <label className="field">
          <span>详细介绍</span>
          <textarea rows={8} value={description} maxLength={20000} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <div className="field-row">
          <div className="field">
            <span>类型</span>
            <div className="chip-row">
              {CATEGORY_KEYS.map((category) => (
                <button
                  key={category}
                  type="button"
                  className={categories.includes(category) ? 'chip on' : 'chip'}
                  onClick={() => toggleCategory(category)}
                >
                  {CATEGORY_LABELS[category] ?? category}
                </button>
              ))}
            </div>
          </div>
          <label className="field narrow">
            <span>排序值（越大越靠前）</span>
            <input value={sortOrder} inputMode="numeric" onChange={(event) => setSortOrder(event.target.value)} />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>展示版本号</span>
            <input value={displayVersion} maxLength={40} placeholder="留空表示不显示版本" onChange={(event) => setDisplayVersion(event.target.value)} />
          </label>
          <div className="field">
            <span>状态</span>
            <div className="switch-row">
              <label className="check">
                <input type="checkbox" checked={published} onChange={(event) => setPublished(event.target.checked)} />
                上架到首页
              </label>
              <label className="check">
                <input type="checkbox" checked={demo} onChange={(event) => setDemo(event.target.checked)} />
                标记为示例
              </label>
            </div>
          </div>
        </div>
        <div className="editor-actions">
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? '保存中…' : '保存修改'}
          </button>
          {!published ? <span className="muted small">{project.unpublishReason ?? '当前处于下架状态，首页看不到它。'}</span> : null}
        </div>
      </form>

      <section className="editor-card">
        <h3>封面</h3>
        <div className="media-row">
          <div className="cover-preview">
            {project.cover ? <img src={project.cover.url} alt={project.cover.alt} /> : <span className="muted">暂无封面</span>}
          </div>
          <div className="media-actions">
            <p className="muted small">建议 16:10、宽度 1200px 以上，支持 PNG / JPEG / WebP。</p>
            <input
              ref={coverInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => void upload('cover', event.target.files?.[0])}
            />
            <div className="media-buttons">
              <button type="button" className="btn subtle" disabled={uploading !== null} onClick={() => coverInput.current?.click()}>
                {uploading === 'cover' ? '上传中…' : project.cover ? '替换封面' : '上传封面'}
              </button>
              {project.cover ? (
                <button type="button" className="btn danger" onClick={() => void removeCover()}>
                  移除
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section className="editor-card">
        <h3>截图（{project.screenshots.length}）</h3>
        <div className="shots-grid">
          {project.screenshots.map((shot, index) => (
            <figure key={shot.fileName} className="shot">
              <img src={shot.url} alt={shot.alt} loading="lazy" />
              <figcaption>
                <span className="muted small">#{index + 1}</span>
                <button type="button" className="link danger" onClick={() => void removeShot(index)}>
                  删除
                </button>
              </figcaption>
            </figure>
          ))}
          {project.screenshots.length === 0 ? <p className="muted small">还没有截图。详情弹窗只展示封面。</p> : null}
        </div>
        <div className="media-buttons">
          <input
            ref={shotsInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => void upload('shots', event.target.files?.[0])}
          />
          <button type="button" className="btn subtle" disabled={uploading !== null} onClick={() => shotsInput.current?.click()}>
            {uploading === 'shots' ? '上传中…' : '添加截图'}
          </button>
        </div>
      </section>
    </div>
  );
}

function PasswordPanel({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致');
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ kickedSessions: number }>('/api/admin/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      onDone(`密码已更新，其它设备上的 ${result.kickedSessions} 个登录已失效`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <form className="admin-card modal-card" onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <h2>修改管理密码</h2>
        <label className="field">
          <span>当前密码</span>
          <input type="password" value={currentPassword} autoComplete="current-password" onChange={(event) => setCurrentPassword(event.target.value)} />
        </label>
        <label className="field">
          <span>新密码（至少 8 位，含字母和数字）</span>
          <input type="password" value={newPassword} autoComplete="new-password" onChange={(event) => setNewPassword(event.target.value)} />
        </label>
        <label className="field">
          <span>再输一次新密码</span>
          <input type="password" value={confirmPassword} autoComplete="new-password" onChange={(event) => setConfirmPassword(event.target.value)} />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" className="btn subtle" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn primary" disabled={busy || !currentPassword || !newPassword}>
            {busy ? '保存中…' : '保存新密码'}
          </button>
        </div>
      </form>
    </div>
  );
}
