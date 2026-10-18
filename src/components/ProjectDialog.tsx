import { useEffect, useMemo, useRef } from 'react';
import { CATEGORY_LABELS, PLATFORM_LABELS, type PublicProject } from '../../shared/types';
import { formatBytes, formatDate } from '../format';
import { copyText, shareUrlFor } from '../share';
import { Gallery, type GalleryImage } from './Gallery';
import { IconClose, IconDownload, IconExternal, IconShare } from './icons';

const PLATFORM_ORDER: Record<string, number> = {
  windows: 0,
  android: 1,
  html: 2,
  linux: 3,
  macos: 4,
  other: 5,
};

interface ProjectDialogProps {
  project: PublicProject | null;
  onClose: () => void;
  onShared: (message: string) => void;
}

/**
 * 详情弹窗：使用原生 <dialog> + showModal()。
 * 原生 dialog 自带焦点陷阱、Esc 关闭和“关闭后焦点回到触发元素”，
 * 这里额外补上：点遮罩关闭、背景滚动锁定、内容区独立滚动、移动端全屏面板。
 */
export function ProjectDialog({ project, onClose, onShared }: ProjectDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const open = project !== null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => {
      body.style.overflow = previousOverflow;
    };
  }, [open]);

  const images = useMemo<GalleryImage[]>(() => {
    if (!project) return [];
    const list: GalleryImage[] = [];
    if (project.cover) {
      list.push({ url: project.cover.url, alt: project.cover.alt || `${project.title} 封面` });
    }
    for (const shot of project.screenshots) {
      list.push({ url: shot.url, alt: shot.alt || `${project.title} 预览图` });
    }
    return list;
  }, [project]);

  const downloads = useMemo(() => {
    if (!project) return [];
    return [...project.downloads].sort((a, b) => {
      const orderA = PLATFORM_ORDER[a.platform] ?? 9;
      const orderB = PLATFORM_ORDER[b.platform] ?? 9;
      if (orderA !== orderB) return orderA - orderB;
      return a.fileName.localeCompare(b.fileName, 'zh-CN');
    });
  }, [project]);

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      aria-labelledby="project-dialog-title"
      onClose={onClose}
      onClick={(event) => {
        // 只有点在 <dialog> 自身（即遮罩区域）时才关闭，内部点击不会误关
        if (event.target === dialogRef.current) onClose();
      }}
    >
      {project ? (
        <div className="dialog-panel">
          <header className="dialog-head">
            <div className="dialog-head-main">
              <h2 className="dialog-title" id="project-dialog-title">
                {project.title}
              </h2>
              <div className="dialog-sub">
                {project.categories.map((category) => (
                  <span className="tag" key={category}>
                    {CATEGORY_LABELS[category]}
                  </span>
                ))}
                {project.demo ? <span className="platform-pill">示例数据</span> : null}
                <span>{project.displayVersion ? `版本 ${project.displayVersion}` : '未标注版本'}</span>
                <span>更新于 {formatDate(project.updatedAt)}</span>
              </div>
            </div>
            <button type="button" className="dialog-close" onClick={onClose} aria-label="关闭项目详情">
              <IconClose size={18} />
            </button>
          </header>

          <div className="dialog-body">
            <Gallery key={project.slug} images={images} title={project.title} />

            <section>
              <h3 className="section-title">项目介绍</h3>
              <p className="description">
                {project.description.trim() || project.summary.trim() || '该项目暂未提供详细介绍。'}
              </p>
            </section>

            <section>
              <h3 className="section-title">体验与下载</h3>
              {project.web === null && downloads.length === 0 ? (
                <p className="note-muted">该项目暂未提供在线体验或可下载文件。</p>
              ) : (
                <>
                  {project.web ? (
                    <div className="actions" style={{ marginBottom: downloads.length > 0 ? 14 : 0 }}>
                      <a
                        className="btn btn-primary"
                        href={project.web.publicUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <IconExternal size={16} />
                        在线体验
                      </a>
                    </div>
                  ) : null}

                  {downloads.length > 0 ? (
                    <ul className="download-list">
                      {downloads.map((download) => (
                        <li className="download-item" key={download.id}>
                          <span className="platform-pill">{PLATFORM_LABELS[download.platform]}</span>
                          <div className="download-main">
                            <p className="download-name">{download.fileName}</p>
                            <p className="download-meta">
                              <span>{formatBytes(download.size)}</span>
                              {download.version ? <span>v{download.version}</span> : null}
                              {download.isDefault ? <span>默认下载</span> : null}
                            </p>
                          </div>
                          <div className="download-action">
                            <a className="btn btn-ghost" href={download.publicUrl} download>
                              <IconDownload size={16} />
                              下载
                            </a>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              )}
            </section>

            <section>
              <h3 className="section-title">分享</h3>
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={async () => {
                    const ok = await copyText(shareUrlFor(project.slug));
                    onShared(ok ? '分享链接已复制，对方打开会自动打开这个项目' : '复制失败，请手动复制地址栏里的链接');
                  }}
                >
                  <IconShare size={16} />
                  复制分享链接
                </button>
              </div>
            </section>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
