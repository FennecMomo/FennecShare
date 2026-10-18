import { useState } from 'react';
import { IconChevronLeft, IconChevronRight } from './icons';

export interface GalleryImage {
  url: string;
  alt: string;
}

interface GalleryProps {
  images: GalleryImage[];
  title: string;
}

const PLACEHOLDER_COVER = '/placeholder-cover.svg';

/**
 * 预览图切换：上一张 / 下一张 / 缩略图，键盘左右方向键可用。
 * 只有一张图时不渲染导航，但仍然保留图片标题。
 */
export function Gallery({ images, title }: GalleryProps) {
  const [index, setIndex] = useState(0);
  const [broken, setBroken] = useState<Record<number, boolean>>({});
  const total = images.length;
  const safeIndex = total === 0 ? 0 : Math.min(index, total - 1);
  const current = total > 0 ? images[safeIndex] : null;
  const currentBroken = current ? broken[safeIndex] === true : false;
  const src = !current || currentBroken ? PLACEHOLDER_COVER : current.url;

  const go = (delta: number) => {
    if (total <= 1) return;
    setIndex((previous) => (previous + delta + total) % total);
  };

  return (
    <div className="gallery">
      <div
        className="gallery-stage"
        role="group"
        aria-roledescription="图片查看器"
        aria-label={`${title} 的预览图`}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            go(-1);
          } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            go(1);
          }
        }}
      >
        <img
          src={src}
          alt={current && !currentBroken ? current.alt : `${title} 暂无预览图`}
          onError={() => setBroken((previous) => ({ ...previous, [safeIndex]: true }))}
          key={src}
        />
        {total > 1 ? (
          <>
            <button
              type="button"
              className="gallery-nav gallery-prev"
              onClick={() => go(-1)}
              aria-label="上一张预览图"
            >
              <IconChevronLeft size={18} />
            </button>
            <button
              type="button"
              className="gallery-nav gallery-next"
              onClick={() => go(1)}
              aria-label="下一张预览图"
            >
              <IconChevronRight size={18} />
            </button>
          </>
        ) : null}
        {total > 1 ? (
          <span className="gallery-counter">
            {safeIndex + 1} / {total}
          </span>
        ) : null}
      </div>

      {total > 1 ? (
        <div className="gallery-thumbs" role="tablist" aria-label="选择预览图">
          {images.map((image, imageIndex) => (
            <button
              key={`${image.url}-${imageIndex}`}
              type="button"
              role="tab"
              className="gallery-thumb"
              aria-current={imageIndex === safeIndex}
              aria-label={`第 ${imageIndex + 1} 张：${image.alt}`}
              onClick={() => setIndex(imageIndex)}
            >
              <img
                src={broken[imageIndex] ? PLACEHOLDER_COVER : image.url}
                alt=""
                loading="lazy"
                onError={() => setBroken((previous) => ({ ...previous, [imageIndex]: true }))}
              />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
