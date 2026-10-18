import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Tab = 'projects' | 'tags' | 'stats';

interface AdminProject {
  slug: string;
  title: string;
  summary: string;
  description: string;
  categories: string[];
  tags: string[];
  demo: boolean;
  sortOrder: number;
  displayVersion: string | null;
  published: boolean;
  unpublishReason: string | null;
  publishedAt: string | null;
  updatedAt: string;
  cover: { url: string; alt: string; releaseId: string; fileName: string } | null;
  screenshots: Array<{ url: string; alt: string; releaseId: string; fileName: string }>;
  web: { entry: string; publicUrl: string; releaseId: string } | null;
  downloads: Array<{ fileName: string; platform: string; version: string | null; size: number; publicUrl: string }>;
  releaseCount: number;
}

interface SessionInfo {
  authenticated: boolean;
  passwordConfigured: boolean;
  passwordUpdatedAt: string | null;
}

interface TagItem {
  label: string;
  createdAt: string;
  projectCount: number;
}

interface StatsResponse {
  generatedAt: string;
  days: number;
  totals: { playClicks: number; shareClicks: number; downloads: number; events: number };
  byProject: Record<string, { playClicks: number; shareClicks: number; downloads: number; lastEventAt: string | null }>;
  byPlatform: Record<string, number>;
  byDay: Array<{ date: string; playClicks: number; shareClicks: number; downloads: number }>;
  lastEventAt: string | null;
  storage: { file: string; bytes: number };
  titles: Record<string, string>;
}

const CATEGORY_LABELS: Record<string, string> = {
  web: '网页',
  desktop: '桌面应用',
  mobile: '手机 APP',
};

const CATEGORY_KEYS = ['web', 'desktop', 'mobile'];
const PLATFORM_KEYS = ['windows', 'android', 'html', 'linux', 'macos', 'other'];
const PLATFORM_LABELS: Record<string, string> = {
  windows: 'Windows',
  android: 'Android',
  html: '网页包',
  linux: 'Linux',
  macos: 'macOS',
  other: '其他',
};

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
    throw new ApiError(
      response.status,
      error?.code ?? 'request_failed',
      error?.message ?? `请求失败（${response.status}）`,
    );
  }
  return payload as T;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function AdminApp() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>('projects');
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [revision, setRevision] = useState<number | null>(null);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [tagRegistry, setTagRegistry] = useState<string[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  const [showPasswordPanel, setShowPasswordPanel] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  const activeProject = useMemo(
    () => projects.find((project) => project.slug === activeSlug) ?? null,
    [activeSlug, projects],
  );

  const allTags = useMemo(() => {
    const set = new Set<string>(tagRegistry);
    for (const project of projects) for (const tag of project.tags) set.add(tag);
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [projects, tagRegistry]);

  const showToast = useCallback((text: string) => setToast({ text, id: Date.now() }), []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3600);
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
      const tags = await api<{ tags: Array<{ label: string }> }>('/api/admin/tags').catch(() => null);
      if (tags) setTagRegistry(tags.tags.map((tag) => tag.label));
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

      <nav className="admin-tabs" aria-label="管理分类">
        {(
          [
            ['projects', '项目'],
            ['tags', '标签'],
            ['stats', '数据'],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? 'admin-tab is-active' : 'admin-tab'}
            aria-current={tab === key ? 'page' : undefined}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      {listError ? <p className="error">{listError}</p> : null}

      {tab === 'projects' ? (
        <div className="admin-layout">
          <aside className="admin-list" aria-label="项目列表">
            <button type="button" className="btn primary wide" onClick={() => setShowCreate(true)}>
              ＋ 添加项目
            </button>
            {projects.map((project) => (
              <button
                key={project.slug}
                type="button"
                className={project.slug === activeSlug ? 'admin-list-item active' : 'admin-list-item'}
                onClick={() => setActiveSlug(project.slug)}
              >
                <span className="thumb">
                  {project.cover ? (
                    <img src={project.cover.url} alt="" loading="lazy" />
                  ) : (
                    <span className="thumb-empty">无图</span>
                  )}
                </span>
                <span className="list-text">
                  <strong>{project.title}</strong>
                  <span className="muted small">{project.slug}</span>
                </span>
                <span className={project.published ? 'pill ok' : 'pill off'}>
                  {project.published ? '已上架' : '已下架'}
                </span>
              </button>
            ))}
            {projects.length === 0 ? <p className="muted">还没有项目。</p> : null}
          </aside>

          <main className="admin-editor">
            {activeProject ? (
              <ProjectEditor
                key={activeProject.slug}
                project={activeProject}
                allTags={allTags}
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
      ) : null}

      {tab === 'tags' ? (
        <TagsPanel
          projects={projects}
          onChanged={async (message) => {
            showToast(message);
            await loadProjects();
          }}
          onError={(message) => showToast(message)}
        />
      ) : null}

      {tab === 'stats' ? <StatsPanel /> : null}

      {showCreate ? (
        <CreateProjectModal
          allTags={allTags}
          onClose={() => setShowCreate(false)}
          onDone={async (slug, message) => {
            setShowCreate(false);
            showToast(message);
            await loadProjects();
            setActiveSlug(slug);
          }}
          onError={(message) => showToast(message)}
        />
      ) : null}

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
  allTags: string[];
  onChanged: (message: string) => Promise<void> | void;
  onError: (message: string) => void;
}

function ProjectEditor({ project, allTags, onChanged, onError }: EditorProps) {
  const [title, setTitle] = useState(project.title);
  const [summary, setSummary] = useState(project.summary);
  const [description, setDescription] = useState(project.description);
  const [categories, setCategories] = useState<string[]>(project.categories);
  const [tags, setTags] = useState<string[]>(project.tags);
  const [sortOrder, setSortOrder] = useState(String(project.sortOrder));
  const [displayVersion, setDisplayVersion] = useState(project.displayVersion ?? '');
  const [demo, setDemo] = useState(project.demo);
  const [published, setPublished] = useState(project.published);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<'cover' | 'shots' | 'web' | 'download' | null>(null);

  const [downloadPlatform, setDownloadPlatform] = useState('windows');
  const [downloadVersion, setDownloadVersion] = useState('');
  const [downloadDefault, setDownloadDefault] = useState(false);

  const coverInput = useRef<HTMLInputElement | null>(null);
  const shotsInput = useRef<HTMLInputElement | null>(null);
  const webInput = useRef<HTMLInputElement | null>(null);
  const downloadInput = useRef<HTMLInputElement | null>(null);

  const toggleCategory = (category: string) => {
    setCategories((previous) =>
      previous.includes(category) ? previous.filter((item) => item !== category) : [...previous, category],
    );
  };

  const toggleTag = (tag: string) => {
    setTags((previous) => (previous.includes(tag) ? previous.filter((item) => item !== tag) : [...previous, tag]));
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
          tags,
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

  const uploadImage = async (kind: 'cover' | 'shots', file: File | undefined) => {
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

  const uploadWeb = async (file: File | undefined) => {
    if (!file) return;
    const isZip = /\.zip$/i.test(file.name);
    const isHtml = /\.html?$/i.test(file.name);
    if (!isZip && !isHtml) {
      onError('只接受 .html 文件或 .zip 包');
      return;
    }
    setUploading('web');
    try {
      const buffer = await file.arrayBuffer();
      const result = await api<{ message: string }>(`/api/admin/projects/${project.slug}/web`, {
        method: 'PUT',
        headers: {
          'Content-Type': isZip ? 'application/zip' : 'text/html; charset=utf-8',
          'x-file-name': encodeURIComponent(file.name),
        },
        body: buffer,
      });
      await onChanged(result.message);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(null);
      if (webInput.current) webInput.current.value = '';
    }
  };

  const clearWeb = async () => {
    if (!window.confirm('确定移除这个项目的试玩包吗？文件会留在历史版本里，但线上不再能玩。')) return;
    try {
      const result = await api<{ message: string }>(`/api/admin/projects/${project.slug}/web`, { method: 'DELETE' });
      await onChanged(result.message);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  const uploadDownload = async (file: File | undefined) => {
    if (!file) return;
    setUploading('download');
    try {
      const buffer = await file.arrayBuffer();
      const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'x-file-name': encodeURIComponent(file.name),
        'x-platform': downloadPlatform,
      };
      if (downloadVersion.trim().length > 0) headers['x-version'] = encodeURIComponent(downloadVersion.trim());
      if (downloadDefault) headers['x-default'] = '1';
      const result = await api<{ message: string }>(`/api/admin/projects/${project.slug}/downloads`, {
        method: 'POST',
        headers,
        body: buffer,
      });
      await onChanged(result.message);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(null);
      if (downloadInput.current) downloadInput.current.value = '';
    }
  };

  const removeDownload = async (fileName: string) => {
    if (!window.confirm(`确定删除下载包「${fileName}」吗？`)) return;
    try {
      await api(`/api/admin/projects/${project.slug}/downloads/${encodeURIComponent(fileName)}`, { method: 'DELETE' });
      await onChanged(`已删除下载包 ${fileName}`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
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

      <section className="editor-card">
        <h3>试玩包（一键发布）</h3>
        <p className="muted small">
          选一个 <code>.html</code> 单文件或 <code>.zip</code> 就能直接上线；ZIP 会自动找入口文件。
          每次发布都会生成新的版本目录，老版本留在历史里可回滚。
        </p>
        {project.web ? (
          <p className="muted small">
            当前入口：<code>{project.web.entry}</code> · 版本 {project.web.releaseId}
          </p>
        ) : (
          <p className="muted small">当前还没有试玩包。</p>
        )}
        <div className="media-buttons">
          <input
            ref={webInput}
            type="file"
            accept=".html,.htm,.zip,application/zip,text/html"
            onChange={(event) => void uploadWeb(event.target.files?.[0])}
          />
          <button
            type="button"
            className="btn primary"
            disabled={uploading !== null}
            onClick={() => webInput.current?.click()}
          >
            {uploading === 'web' ? '发布中…' : project.web ? '发布新版本（HTML/ZIP）' : '上传并发布试玩'}
          </button>
          {project.web ? (
            <button type="button" className="btn danger" onClick={() => void clearWeb()}>
              移除试玩包
            </button>
          ) : null}
        </div>
      </section>

      <section className="editor-card">
        <h3>下载包（{project.downloads.length}）</h3>
        <p className="muted small">
          上传后立刻出现在卡片与详情里；同名文件会覆盖旧版本。每种平台都可以放一个包。
        </p>
        <ul className="download-admin-list">
          {project.downloads.map((download) => (
            <li key={download.fileName}>
              <span className="platform-pill">{PLATFORM_LABELS[download.platform] ?? download.platform}</span>
              <span className="dl-name">{download.fileName}</span>
              <span className="muted small">{formatBytes(download.size)}</span>
              {download.version ? <span className="muted small">v{download.version}</span> : null}
              <button type="button" className="link danger" onClick={() => void removeDownload(download.fileName)}>
                删除
              </button>
            </li>
          ))}
          {project.downloads.length === 0 ? <li className="muted small">还没有下载包。</li> : null}
        </ul>
        <div className="download-upload-row">
          <label className="field narrow">
            <span>平台</span>
            <select value={downloadPlatform} onChange={(event) => setDownloadPlatform(event.target.value)}>
              {PLATFORM_KEYS.map((platform) => (
                <option key={platform} value={platform}>
                  {PLATFORM_LABELS[platform]}
                </option>
              ))}
            </select>
          </label>
          <label className="field narrow">
            <span>版本号</span>
            <input
              value={downloadVersion}
              placeholder="可选"
              onChange={(event) => setDownloadVersion(event.target.value)}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={downloadDefault}
              onChange={(event) => setDownloadDefault(event.target.checked)}
            />
            设为默认下载
          </label>
          <input ref={downloadInput} type="file" onChange={(event) => void uploadDownload(event.target.files?.[0])} />
          <button
            type="button"
            className="btn primary"
            disabled={uploading !== null}
            onClick={() => downloadInput.current?.click()}
          >
            {uploading === 'download' ? '上传中…' : '上传下载包'}
          </button>
        </div>
      </section>

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
          <textarea
            rows={8}
            value={description}
            maxLength={20000}
            onChange={(event) => setDescription(event.target.value)}
          />
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
        <div className="field">
          <span>标签</span>
          <div className="chip-row">
            {allTags.length === 0 ? (
              <span className="muted small">还没有标签，先去「标签」页添加。</span>
            ) : (
              allTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className={tags.includes(tag) ? 'chip on' : 'chip'}
                  onClick={() => toggleTag(tag)}
                >
                  #{tag}
                </button>
              ))
            )}
          </div>
        </div>
        <div className="field-row">
          <label className="field">
            <span>展示版本号</span>
            <input
              value={displayVersion}
              maxLength={40}
              placeholder="留空表示不显示版本"
              onChange={(event) => setDisplayVersion(event.target.value)}
            />
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
          {!published ? (
            <span className="muted small">{project.unpublishReason ?? '当前处于下架状态，首页看不到它。'}</span>
          ) : null}
        </div>
      </form>

      <section className="editor-card">
        <h3>封面</h3>
        <div className="media-row">
          <div className="cover-preview">
            {project.cover ? (
              <img src={project.cover.url} alt={project.cover.alt} />
            ) : (
              <span className="muted">暂无封面</span>
            )}
          </div>
          <div className="media-actions">
            <p className="muted small">建议 16:10、宽度 1200px 以上，支持 PNG / JPEG / WebP。</p>
            <input
              ref={coverInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => void uploadImage('cover', event.target.files?.[0])}
            />
            <div className="media-buttons">
              <button
                type="button"
                className="btn subtle"
                disabled={uploading !== null}
                onClick={() => coverInput.current?.click()}
              >
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
            onChange={(event) => void uploadImage('shots', event.target.files?.[0])}
          />
          <button
            type="button"
            className="btn subtle"
            disabled={uploading !== null}
            onClick={() => shotsInput.current?.click()}
          >
            {uploading === 'shots' ? '上传中…' : '添加截图'}
          </button>
        </div>
      </section>
    </div>
  );
}

function CreateProjectModal({
  allTags,
  onClose,
  onDone,
  onError,
}: {
  allTags: string[];
  onClose: () => void;
  onDone: (slug: string, message: string) => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [categories, setCategories] = useState<string[]>(['web']);
  const [tags, setTags] = useState<string[]>([]);
  const [published, setPublished] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await api<{ slug: string; message: string }>('/api/admin/projects', {
        method: 'POST',
        body: JSON.stringify({
          slug: slug.trim().toLowerCase(),
          title,
          summary,
          categories,
          tags,
          published,
        }),
      });
      await onDone(result.slug, result.message);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <form
        className="admin-card modal-card wide-card"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <h2>添加项目</h2>
        <p className="muted small">
          先建记录，再上传试玩包 / 下载包 / 图片。slug 用于链接（<code>/play/&lt;slug&gt;/</code>），建好后不能改。
        </p>
        <label className="field">
          <span>slug（小写字母、数字、连字符）</span>
          <input
            value={slug}
            placeholder="my-tool"
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            onChange={(event) => setSlug(event.target.value)}
          />
        </label>
        <label className="field">
          <span>标题</span>
          <input value={title} required maxLength={120} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="field">
          <span>卡片简介</span>
          <textarea rows={2} value={summary} maxLength={400} onChange={(event) => setSummary(event.target.value)} />
        </label>
        <div className="field">
          <span>类型</span>
          <div className="chip-row">
            {CATEGORY_KEYS.map((category) => (
              <button
                key={category}
                type="button"
                className={categories.includes(category) ? 'chip on' : 'chip'}
                onClick={() =>
                  setCategories((previous) =>
                    previous.includes(category)
                      ? previous.filter((item) => item !== category)
                      : [...previous, category],
                  )
                }
              >
                {CATEGORY_LABELS[category]}
              </button>
            ))}
          </div>
        </div>
        {allTags.length > 0 ? (
          <div className="field">
            <span>标签</span>
            <div className="chip-row">
              {allTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className={tags.includes(tag) ? 'chip on' : 'chip'}
                  onClick={() =>
                    setTags((previous) =>
                      previous.includes(tag) ? previous.filter((item) => item !== tag) : [...previous, tag],
                    )
                  }
                >
                  #{tag}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <label className="check">
          <input type="checkbox" checked={published} onChange={(event) => setPublished(event.target.checked)} />
          立即上架到首页
        </label>
        {error ? <p className="error">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" className="btn subtle" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn primary" disabled={busy || slug.length === 0 || title.length === 0}>
            {busy ? '创建中…' : '创建项目'}
          </button>
        </div>
      </form>
    </div>
  );
}

function TagsPanel({
  projects,
  onChanged,
  onError,
}: {
  projects: AdminProject[];
  onChanged: (message: string) => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const [items, setItems] = useState<TagItem[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const [reloadToken, setReloadToken] = useState(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    void api<{ revision: number; tags: TagItem[] }>('/api/admin/tags')
      .then((data) => {
        if (!cancelled) setItems(data.tags);
      })
      .catch((error: unknown) => {
        if (!cancelled) onErrorRef.current(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken, projects.length]);

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const label = draft.trim();
    if (label.length === 0) return;
    setBusy(true);
    try {
      const result = await api<{ revision: number; tag: { label: string } }>('/api/admin/tags', {
        method: 'POST',
        body: JSON.stringify({ label }),
      });
      setDraft('');
      reload();
      await onChanged(`标签「${result.tag.label}」已添加`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (label: string, projectCount: number) => {
    const warn =
      projectCount > 0
        ? `标签「${label}」正被 ${projectCount} 个项目使用，删除后会从这些项目上一起摘掉。确定吗？`
        : `确定删除标签「${label}」吗？`;
    if (!window.confirm(warn)) return;
    try {
      const result = await api<{ affectedProjects: string[] }>(`/api/admin/tags/${encodeURIComponent(label)}`, {
        method: 'DELETE',
      });
      reload();
      await onChanged(
        result.affectedProjects.length > 0
          ? `标签「${label}」已删除，并从 ${result.affectedProjects.length} 个项目上摘掉`
          : `标签「${label}」已删除`,
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="editor-stack">
      <section className="editor-card">
        <h3>标签管理</h3>
        <p className="muted small">
          标签是自由文本，先在登记表里建，再在项目上勾选。前台会按标签筛选，一个项目可以有多个标签。
        </p>
        <form className="tag-add-row" onSubmit={add}>
          <input
            value={draft}
            maxLength={20}
            placeholder="例如：游戏 / 工具 / 实验"
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className="btn primary" disabled={busy || draft.trim().length === 0}>
            {busy ? '添加中…' : '添加标签'}
          </button>
        </form>
        <ul className="tag-admin-list">
          {items.map((item) => (
            <li key={item.label}>
              <span className="tag-chip is-active">#{item.label}</span>
              <span className="muted small">{item.projectCount} 个项目</span>
              <button type="button" className="link danger" onClick={() => void remove(item.label, item.projectCount)}>
                删除
              </button>
            </li>
          ))}
          {items.length === 0 ? <li className="muted small">还没有标签。</li> : null}
        </ul>
      </section>
    </div>
  );
}

function StatsPanel() {
  const [days, setDays] = useState(14);
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api<StatsResponse>(`/api/admin/stats?days=${days}`)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const rows = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.byProject)
      .map(([slug, stats]) => ({ slug, title: data.titles[slug] ?? slug, ...stats }))
      .sort(
        (a, b) => b.playClicks + b.shareClicks + b.downloads - (a.playClicks + a.shareClicks + a.downloads),
      );
  }, [data]);

  const maxDay = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, ...data.byDay.map((day) => day.playClicks + day.shareClicks + day.downloads));
  }, [data]);

  if (error) return <p className="error">数据加载失败：{error}</p>;
  if (!data) return <p className="muted">正在加载数据…</p>;

  return (
    <div className="editor-stack">
      <section className="editor-card">
        <div className="stats-head">
          <h3>数据总览</h3>
          <div className="chip-row">
            {[7, 14, 30].map((value) => (
              <button
                key={value}
                type="button"
                className={days === value ? 'chip on' : 'chip'}
                onClick={() => setDays(value)}
              >
                近 {value} 天
              </button>
            ))}
          </div>
        </div>
        <div className="stat-cards">
          <div className="stat-card">
            <span className="muted small">试玩点击</span>
            <strong>{data.totals.playClicks}</strong>
          </div>
          <div className="stat-card">
            <span className="muted small">分享点击</span>
            <strong>{data.totals.shareClicks}</strong>
          </div>
          <div className="stat-card">
            <span className="muted small">下载次数</span>
            <strong>{data.totals.downloads}</strong>
          </div>
          <div className="stat-card">
            <span className="muted small">最近一次事件</span>
            <strong className="small-strong">{formatTime(data.lastEventAt)}</strong>
          </div>
        </div>
        <p className="muted small">
          埋点只记录事件类型、项目与时间，不记 IP / UA / cookie。当前数据文件 {formatBytes(data.storage.bytes)}。
        </p>
      </section>

      <section className="editor-card">
        <h3>近 {days} 天趋势</h3>
        <div className="day-bars">
          {data.byDay.map((day) => {
            const total = day.playClicks + day.shareClicks + day.downloads;
            const height = Math.round((total / maxDay) * 100);
            return (
              <div
                className="day-bar"
                key={day.date}
                title={`${day.date}：试玩 ${day.playClicks} · 分享 ${day.shareClicks} · 下载 ${day.downloads}`}
              >
                <div className="day-bar-track">
                  <div className="day-bar-fill" style={{ height: `${Math.max(height, total > 0 ? 6 : 0)}%` }} />
                </div>
                <span className="day-bar-label">{day.date.slice(5)}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="editor-card">
        <h3>按平台分布</h3>
        <ul className="platform-list">
          {Object.entries(data.byPlatform).length === 0 ? (
            <li className="muted small">还没有下载记录。</li>
          ) : (
            Object.entries(data.byPlatform).map(([platform, count]) => (
              <li key={platform}>
                <span className="platform-pill">{PLATFORM_LABELS[platform] ?? platform}</span>
                <span>{count} 次下载</span>
              </li>
            ))
          )}
        </ul>
      </section>

      <section className="editor-card">
        <h3>按项目</h3>
        <table className="stats-table">
          <thead>
            <tr>
              <th>项目</th>
              <th>试玩点击</th>
              <th>分享点击</th>
              <th>下载</th>
              <th>最近事件</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.slug}>
                <td>
                  <strong>{row.title}</strong>
                  <span className="muted small"> / {row.slug}</span>
                </td>
                <td>{row.playClicks}</td>
                <td>{row.shareClicks}</td>
                <td>{row.downloads}</td>
                <td className="muted small">{formatTime(row.lastEventAt)}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted small">
                  还没有任何埋点数据。有人点分享、点试玩或下载之后这里会有数字。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
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
          <input
            type="password"
            value={currentPassword}
            autoComplete="current-password"
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </label>
        <label className="field">
          <span>新密码（至少 8 位，含字母和数字）</span>
          <input
            type="password"
            value={newPassword}
            autoComplete="new-password"
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </label>
        <label className="field">
          <span>再输一次新密码</span>
          <input
            type="password"
            value={confirmPassword}
            autoComplete="new-password"
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
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
