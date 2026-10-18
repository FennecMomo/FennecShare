import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CATEGORIES, type Category, type PublicProjectView } from '../shared/types';
import { useCatalog } from './hooks/useCatalog';
import { CategoryFilter } from './components/CategoryFilter';
import { ProjectDialog } from './components/ProjectDialog';
import { ProjectGrid } from './components/ProjectGrid';
import { TagFilter } from './components/TagFilter';
import { StatusPanel } from './components/StatusPanel';
import { IconAlert, IconInbox, IconRefresh } from './components/icons';
import { formatDateTime } from './format';
import { readDeepLinkSlug } from './share';

export default function App() {
  const { status, data, error, reload } = useCatalog();
  const [selected, setSelected] = useState<Category[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  const deepLinkHandled = useRef(false);

  const projects = useMemo<PublicProjectView[]>(() => data?.projects ?? [], [data]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selectedTagSet = useMemo(() => new Set(selectedTags), [selectedTags]);
  const allTags = useMemo(() => data?.tags ?? [], [data]);

  const counts = useMemo(() => {
    const result = Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as Record<Category, number>;
    for (const project of projects) {
      for (const category of project.categories) result[category] += 1;
    }
    return result;
  }, [projects]);

  const tagCounts = useMemo(() => {
    const result: Record<string, number> = {};
    for (const tag of allTags) result[tag] = 0;
    for (const project of projects) {
      for (const tag of project.tags) {
        if (tag in result) result[tag] = (result[tag] ?? 0) + 1;
      }
    }
    return result;
  }, [allTags, projects]);

  const visible = useMemo(() => {
    return projects.filter((project) => {
      const categoryOk = selectedSet.size === 0 || project.categories.some((category) => selectedSet.has(category));
      if (!categoryOk) return false;
      if (selectedTagSet.size === 0) return true;
      return project.tags.some((tag) => selectedTagSet.has(tag));
    });
  }, [projects, selectedSet, selectedTagSet]);

  const activeProject = useMemo(
    () => (activeSlug ? projects.find((project) => project.slug === activeSlug) ?? null : null),
    [activeSlug, projects],
  );

  // 数据刷新后如果正在看的项目被下架，自动关掉弹窗
  useEffect(() => {
    if (activeSlug && status === 'ready' && !projects.some((project) => project.slug === activeSlug)) {
      setActiveSlug(null);
    }
  }, [activeSlug, projects, status]);

  const toggleCategory = useCallback((category: Category) => {
    setSelected((previous) =>
      previous.includes(category) ? previous.filter((item) => item !== category) : [...previous, category],
    );
  }, []);

  const toggleTag = useCallback((tag: string) => {
    setSelectedTags((previous) =>
      previous.includes(tag) ? previous.filter((item) => item !== tag) : [...previous, tag],
    );
  }, []);

  const clearFilter = useCallback(() => {
    setSelected([]);
    setSelectedTags([]);
  }, []);

  const showToast = useCallback((text: string) => {
    setToast({ text, id: Date.now() });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // 打开/关闭详情时同步地址栏，分享出去的链接和当前看到的内容始终一致
  const openProject = useCallback((slug: string) => {
    setActiveSlug(slug);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('p', slug);
      window.history.replaceState(null, '', url.toString());
    } catch {
      // 地址栏不可写时忽略，不影响弹窗
    }
  }, []);

  const closeProject = useCallback(() => {
    setActiveSlug(null);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('p');
      window.history.replaceState(null, '', url.toString());
    } catch {
      // 同上
    }
  }, []);


  // 带 ?p=<slug> 打开时，数据就绪后自动弹出对应项目
  useEffect(() => {
    if (status !== 'ready' || deepLinkHandled.current) return;
    const slug = readDeepLinkSlug();
    if (!slug) {
      deepLinkHandled.current = true;
      return;
    }
    deepLinkHandled.current = true;
    if (projects.some((project) => project.slug === slug)) {
      setActiveSlug(slug);
    } else {
      showToast('链接里的项目不存在或已下架');
    }
  }, [projects, showToast, status]);

  const showInitialLoading = status === 'loading' && data === null;
  const showInitialError = status === 'error' && data === null;
  const showEmpty = status === 'ready' && projects.length === 0;
  const showFilteredEmpty = !showInitialLoading && !showInitialError && !showEmpty && visible.length === 0;

  return (
    <>
      <header className="site-header">
        <div className="shell header-inner">
          <div className="brand">
            <img className="brand-mark" src="/favicon.svg" alt="" width={46} height={46} />
            <div className="brand-text">
              <h1 className="brand-title">
                Fennec <span>Share</span>
              </h1>
              <p className="brand-tagline">整理做过的小项目，在线体验或直接下载。</p>
            </div>
          </div>

          <CategoryFilter
            selected={selectedSet}
            counts={counts}
            total={projects.length}
            onToggle={toggleCategory}
            onClear={clearFilter}
          />
        </div>
      </header>

      <main className="shell">
        <div className="result-bar">
          <p className="result-summary" aria-live="polite">
            {showInitialLoading ? (
              '正在加载项目…'
            ) : selectedSet.size === 0 && selectedTagSet.size === 0 ? (
              <>
                共 <b>{projects.length}</b> 个项目
              </>
            ) : (
              <>
                筛选出 <b>{visible.length}</b> / {projects.length} 个项目
              </>
            )}
          </p>
          {selectedSet.size > 0 || selectedTagSet.size > 0 ? (
            <button type="button" className="result-reset" onClick={clearFilter}>
              清除筛选
            </button>
          ) : null}
        </div>

        <TagFilter
          tags={allTags}
          selected={selectedTagSet}
          counts={tagCounts}
          onToggle={toggleTag}
          onClear={() => setSelectedTags([])}
        />

        {status === 'error' && data !== null ? (
          <div className="note-muted" style={{ marginBottom: 16 }} role="status">
            项目列表刷新失败（{error}），当前显示的是上一次成功加载的内容。
            <button type="button" className="result-reset" onClick={reload}>
              重试
            </button>
          </div>
        ) : null}

        {showInitialLoading ? <ProjectGrid projects={[]} onOpen={openProject} onShared={showToast} /> : null}

        {showInitialError ? (
          <StatusPanel
            icon={<IconAlert size={26} />}
            title="项目列表加载失败"
            text={error ?? '请检查网络或稍后重试。'}
            actions={
              <button type="button" className="btn btn-primary" onClick={reload}>
                <IconRefresh size={16} />
                重新加载
              </button>
            }
          />
        ) : null}

        {showEmpty ? (
          <StatusPanel
            icon={<IconInbox size={26} />}
            title="还没有发布任何项目"
            text="项目上架后会立即出现在这里，无需重新构建或重启网站。"
          />
        ) : null}

        {showFilteredEmpty ? (
          <StatusPanel
            icon={<IconInbox size={26} />}
            title="没有符合筛选条件的项目"
            text="换一个类型组合，或者清除筛选查看全部项目。"
            actions={
              <button type="button" className="btn btn-ghost" onClick={clearFilter}>
                清除筛选
              </button>
            }
          />
        ) : null}

        {!showInitialLoading && !showInitialError && !showEmpty && !showFilteredEmpty ? (
          <ProjectGrid projects={visible} onOpen={openProject} onShared={showToast} />
        ) : null}
      </main>

      <footer className="site-footer">
        <div className="shell footer-inner">
          <p>
            Fennec Share · 项目展示与下载站。项目由维护者通过发布工具上架，新项目无需重新构建前端即可显示。
          </p>
          <p className="footer-meta">
            共 {projects.length} 个项目 · 数据更新于 {formatDateTime(data?.generatedAt ?? null)}
          </p>
        </div>
      </footer>

      <ProjectDialog project={activeProject} onClose={closeProject} onShared={showToast} />

      {toast ? (
        <div className="toast" role="status" key={toast.id}>
          {toast.text}
        </div>
      ) : null}
    </>
  );
}
