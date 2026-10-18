import { CATEGORIES, CATEGORY_LABELS, type Category } from '../../shared/types';

interface CategoryFilterProps {
  selected: ReadonlySet<Category>;
  counts: Record<Category, number>;
  total: number;
  onToggle: (category: Category) => void;
  onClear: () => void;
}

/**
 * 类型筛选：多选、OR 匹配。
 * 用原生 button + aria-pressed，键盘 Tab / Space / Enter 都能操作，触屏也没问题。
 */
export function CategoryFilter({ selected, counts, total, onToggle, onClear }: CategoryFilterProps) {
  const allActive = selected.size === 0;

  return (
    <div className="filter">
      <p className="filter-label" id="filter-label">
        按类型筛选（可多选）
      </p>
      <div className="filter-chips" role="group" aria-labelledby="filter-label">
        <button
          type="button"
          className="chip"
          aria-pressed={allActive}
          onClick={onClear}
          title="显示全部项目"
        >
          全部
          <span className="chip-count">{total}</span>
        </button>
        {CATEGORIES.map((category) => (
          <button
            key={category}
            type="button"
            className="chip"
            aria-pressed={selected.has(category)}
            onClick={() => onToggle(category)}
          >
            {CATEGORY_LABELS[category]}
            <span className="chip-count">{counts[category]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
