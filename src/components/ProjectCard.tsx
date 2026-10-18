import { useCallback, useEffect, useRef, useState } from 'react';
import { CATEGORY_LABELS, type PublicProjectView } from '../../shared/types';
import { formatDate } from '../format';
import { copyText, shareUrlFor } from '../share';
import { reportStat } from '../stats';
import { IconCheck, IconDownload, IconExternal, IconShare } from './icons';

const PLACEHOLDER_COVER = '/placeholder-cover.svg';

interface ProjectCardProps {
  project: PublicProjectView;
  onOpen: (slug: string) => void;
  onShared: (message: string) => void;
}

export function ProjectCard({ project, onOpen, onShared }: ProjectCardProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareBonus, setShareBonus] = useState(0);
  const timerRef = useRef<number | null>(null);
  const coverSrc = !project.cover || imageFailed ? PLACEHOLDER_COVER : project.cover.url;

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const handleError = useCallback(() => {
    setImageFailed(true);
  }, []);

  const handleOpen = useCallback(() => {
    onOpen(project.slug);
  }, [onOpen, project.slug]);

  const handleShare = useCallback(async () => {
    const ok = await copyText(shareUrlFor(project.slug));
    if (!ok) {
      onShared('复制失败，请手动复制地址栏里的链接');
      return;
    }
    setCopied(true);
    setShareBonus((value) => value + 1);
    reportStat('share_click', project.slug, 'card');
    onShared(`已复制「${project.title}」的分享链接`);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1800);
  }, [onShared, project.slug, project.title]);

  const hasWeb = project.web !== null;
  const hasDownloads = project.downloads.length > 0;
  const shareCount = project.stats.shareClicks + shareBonus;

  return (
    <article className="card">
      <div className="card-cover">
        {project.demo ? <span className="badge-demo">示例</span> : null}
        <img src={coverSrc} alt="" loading="lazy" decoding="async" onError={handleError} />
      </div>
      <div className="card-body">
        <h3 className="card-title" title={project.title}>
          {project.title}
        </h3>
        <p className="card-summary">{project.summary}</p>
        <div className="card-tags">
          {project.categories.map((category) => (
            <span className="tag" key={category}>
              {CATEGORY_LABELS[category]}
            </span>
          ))}
          {project.tags.map((tag) => (
            <span className="tag tag-project" key={tag}>
              #{tag}
            </span>
          ))}
        </div>
        <div className="card-meta">
          <span className="card-version">
            {project.displayVersion ? `v${project.displayVersion}` : '未标注版本'}
            <span aria-hidden="true"> · </span>
            {formatDate(project.updatedAt)}
          </span>
          <span className="card-hints">
            {hasWeb ? (
              <span className="hint">
                <IconExternal size={13} />
                可在线体验
              </span>
            ) : null}
            {hasDownloads ? (
              <span className="hint">
                <IconDownload size={13} />
                可下载
              </span>
            ) : null}
          </span>
        </div>
        <div className="card-stats" aria-label="项目数据">
          {hasWeb ? (
            <span className="stat" title="试玩点击">
              <span aria-hidden="true">▶</span>
              {project.stats.playClicks}
            </span>
          ) : null}
          <span className="stat" title="分享点击">
            <IconShare size={12} />
            {shareCount}
          </span>
          {hasDownloads ? (
            <span className="stat" title="下载次数">
              <IconDownload size={12} />
              {project.stats.downloads}
            </span>
          ) : null}
        </div>
      </div>
      {/* 分享按钮：z-index 高于整卡覆盖层，点它只复制链接、不打开详情 */}
      <button
        type="button"
        className={copied ? 'card-share is-copied' : 'card-share'}
        onClick={handleShare}
        aria-label={`复制「${project.title}」的分享链接`}
        title="复制分享链接"
      >
        {copied ? <IconCheck size={14} /> : <IconShare size={14} />}
        <span>{copied ? '已复制' : '分享'}</span>
      </button>
      {/* 整卡可点：用一个覆盖整张卡片的按钮，避免把可点击元素套进可点击元素 */}
      <button
        type="button"
        className="card-open"
        onClick={handleOpen}
        aria-haspopup="dialog"
        aria-label={`查看「${project.title}」的详情`}
      />
    </article>
  );
}
