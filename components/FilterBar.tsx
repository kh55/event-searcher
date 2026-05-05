'use client';
import { AREAS, type Area } from '@/lib/area';

export interface Filters {
  datePreset: 'this_weekend' | 'next_weekend' | 'this_month' | 'custom';
  areas: Area[];
  includeOnline: boolean;
  onSaleOnly: boolean;
}

export function FilterBar({
  filters,
  onChange,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
}) {
  const toggleArea = (a: Area) => {
    const next = filters.areas.includes(a)
      ? filters.areas.filter(x => x !== a)
      : [...filters.areas, a];
    onChange({ ...filters, areas: next });
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs uppercase text-gray-500 mb-1">日付</div>
        <div className="flex gap-2 flex-wrap">
          {(['this_weekend', 'next_weekend', 'this_month'] as const).map(p => (
            <button
              key={p}
              onClick={() => onChange({ ...filters, datePreset: p })}
              className={`px-3 py-1 rounded ${
                filters.datePreset === p ? 'bg-blue-500 text-white' : 'bg-gray-200'
              }`}
            >
              {p === 'this_weekend'
                ? '今週末'
                : p === 'next_weekend'
                ? '来週末'
                : '今月'}
            </button>
          ))}
        </div>
      </div>
      <div>
        <div className="text-xs uppercase text-gray-500 mb-1">エリア</div>
        <div className="flex gap-2 flex-wrap">
          {AREAS.map(a => (
            <button
              key={a}
              onClick={() => toggleArea(a)}
              className={`px-3 py-1 rounded ${
                filters.areas.includes(a) ? 'bg-blue-500 text-white' : 'bg-gray-200'
              }`}
            >
              {a}
            </button>
          ))}
        </div>
      </div>
      <div className="flex gap-4 text-sm">
        <label>
          <input
            type="checkbox"
            checked={filters.onSaleOnly}
            onChange={e => onChange({ ...filters, onSaleOnly: e.target.checked })}
          />{' '}
          販売中のみ
        </label>
        <label>
          <input
            type="checkbox"
            checked={filters.includeOnline}
            onChange={e => onChange({ ...filters, includeOnline: e.target.checked })}
          />{' '}
          配信を含める
        </label>
      </div>
    </div>
  );
}
