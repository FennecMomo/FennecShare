interface TagFilterProps {
  tags: string[];
  selected: Set<string>;
  counts: Record<string, number>;
  onToggle: (tag: string) => void;
  onClear: () => void;
}

/** 标签筛选：多选按「任意命中」过滤，和类型筛选是「同时满足」的关系。 */
export function TagFilter({ tags, selected, counts, onToggle, onClear }: TagFilterProps) {
  if (tags.length === 0) return null;

  return (
    <div className="tag-filter" role="group" aria-label="按标签筛选">
      <span className="tag-filter-label">标签</span>
      <div className="tag-filter-list">
        {tags.map((tag) => {
          const active = selected.has(tag);
          const count = counts[tag] ?? 0;
          return (
            <button
              key={tag}
              type="button"
              className={active ? 'tag-chip is-active' : 'tag-chip'}
              aria-pressed={active}
              onClick={() => onToggle(tag)}
            >
              {tag}
              <span className="tag-chip-count">{count}</span>
            </button>
          );
        })}
        {selected.size > 0 ? (
          <button type="button" className="tag-chip tag-chip-clear" onClick={onClear}>
            清除标签
          </button>
        ) : null}
      </div>
    </div>
  );
}
