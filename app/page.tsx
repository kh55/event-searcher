'use client';
import { useState } from 'react';
import { ResultCard } from '@/components/ResultCard';
import { FilterBar, type Filters } from '@/components/FilterBar';
import { getThisWeekend, getNextWeekend } from '@/lib/date';

function rangeFor(preset: Filters['datePreset']) {
  const now = new Date();
  if (preset === 'this_weekend') return getThisWeekend(now);
  if (preset === 'next_weekend') return getNextWeekend(now);
  // this_month
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  return { from, to };
}

export default function HomePage() {
  const [keyword, setKeyword] = useState('');
  const [filters, setFilters] = useState<Filters>({
    datePreset: 'this_weekend',
    areas: ['関東'],
    includeOnline: false,
    onSaleOnly: true,
  });
  const [events, setEvents] = useState<any[]>([]);
  const [meta, setMeta] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  async function search() {
    setLoading(true);
    try {
      const range = rangeFor(filters.datePreset);
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: keyword,
          from: range.from.toISOString(),
          to: range.to.toISOString(),
          areas: filters.areas,
          include_online: filters.includeOnline,
          on_sale_only: filters.onSaleOnly,
        }),
      });
      const data = await res.json();
      setEvents(data.events ?? []);
      setMeta(data.meta ?? null);
    } finally {
      setLoading(false);
    }
  }

  async function saveKeyword() {
    if (!keyword) return;
    await fetch('/api/saved-keywords', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword }),
    });
    alert(`"${keyword}" を保存しました`);
  }

  return (
    <main className="max-w-3xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-4">event-searcher</h1>
      <div className="flex gap-2 mb-4">
        <input
          value={keyword}
          onChange={e => setKeyword(e.target.value)}
          placeholder="キーワード(声優名・作品名など)"
          className="flex-1 border rounded px-3 py-2"
          onKeyDown={e => {
            if (e.key === 'Enter') search();
          }}
        />
        <button
          onClick={search}
          disabled={loading}
          className="px-4 py-2 bg-blue-500 text-white rounded"
        >
          検索
        </button>
      </div>
      <div className="mb-4">
        <FilterBar filters={filters} onChange={setFilters} />
      </div>
      {meta && (
        <div className="text-xs text-gray-500 mb-2">
          {events.length}件 / {meta.fetched_strategy} /{' '}
          {new Date(meta.fetched_at).toLocaleString('ja-JP')}
        </div>
      )}
      <div>
        {events.map(e => (
          <ResultCard key={e.id} event={e} />
        ))}
      </div>
      {events.length > 0 && (
        <div className="text-center mt-4">
          <button onClick={saveKeyword} className="px-4 py-2 border rounded">
            ★ このキーワードを保存
          </button>
        </div>
      )}
    </main>
  );
}
