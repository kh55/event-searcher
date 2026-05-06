'use client';
import { useRef, useState } from 'react';
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
  // setLoading はレンダリングを待つため、連打や Enter 連射の同フレーム内では
  // disabled が反映されない。同期的に弾くために ref を併用する。
  const inFlightRef = useRef(false);

  async function search() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
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
      inFlightRef.current = false;
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
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-2xl font-bold">event-searcher</h1>
        <a href="/settings" className="text-sm text-blue-600 dark:text-blue-400 underline">設定</a>
      </div>
      <div className="flex gap-2 mb-4">
        <input
          value={keyword}
          onChange={e => setKeyword(e.target.value)}
          placeholder="キーワード(声優名・作品名など)"
          className="flex-1 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500"
          onKeyDown={e => {
            if (e.key === 'Enter') search();
          }}
        />
        <button
          onClick={search}
          disabled={loading}
          className="px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50 flex items-center gap-2"
        >
          {loading && (
            <span
              aria-hidden
              className="inline-block w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin"
            />
          )}
          {loading ? '検索中…' : '検索'}
        </button>
      </div>
      <div className="mb-4">
        <FilterBar filters={filters} onChange={setFilters} />
      </div>
      {loading ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center justify-center gap-2 py-10 text-gray-500 dark:text-gray-400"
        >
          <span
            aria-hidden
            className="inline-block w-5 h-5 rounded-full border-2 border-gray-300 dark:border-gray-600 border-t-blue-500 animate-spin"
          />
          <span>検索中…</span>
        </div>
      ) : meta ? (
        <>
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            {events.length}件 / {meta.fetched_strategy} /{' '}
            {new Date(meta.fetched_at).toLocaleString('ja-JP')}
          </div>
          {events.length === 0 ? (
            <div className="text-center py-10 text-gray-500 dark:text-gray-400">
              該当するイベントはありませんでした
            </div>
          ) : (
            <>
              <div>
                {events.map(e => (
                  <ResultCard key={e.id} event={e} />
                ))}
              </div>
              {keyword && (
                <div className="text-center mt-4">
                  <button onClick={saveKeyword} className="px-4 py-2 border border-gray-300 dark:border-gray-700 rounded">
                    ★ このキーワードを保存
                  </button>
                </div>
              )}
            </>
          )}
        </>
      ) : (
        <div className="text-center py-10 text-gray-500 dark:text-gray-400 text-sm">
          キーワードを入力して検索ボタンを押してください
          <span className="block mt-1 text-xs">(空のまま検索すると、保存キーワードに該当するイベントを表示します)</span>
        </div>
      )}
    </main>
  );
}
