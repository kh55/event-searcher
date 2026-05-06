'use client';
import { useEffect, useRef, useState } from 'react';

interface SavedKeyword { id: number; keyword: string; created_at: string; }

const MAX_KEYWORD_LENGTH = 100;

export default function SettingsPage() {
  const [keywords, setKeywords] = useState<SavedKeyword[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    const res = await fetch('/api/saved-keywords');
    const data = await res.json();
    setKeywords(data.keywords ?? []);
    setLoading(false);
  }

  async function add() {
    const trimmed = input.trim();
    if (!trimmed) {
      setError('キーワードを入力してください');
      return;
    }
    if (trimmed.length > MAX_KEYWORD_LENGTH) {
      setError(`${MAX_KEYWORD_LENGTH}文字以内で入力してください`);
      return;
    }
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/saved-keywords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? '追加に失敗しました');
        return;
      }
      setInput('');
      await load();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function remove(id: number) {
    if (!confirm('削除しますか?')) return;
    await fetch(`/api/saved-keywords/${id}`, { method: 'DELETE' });
    load();
  }

  useEffect(() => { load(); }, []);

  return (
    <main className="max-w-3xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-4">設定 / 保存キーワード</h1>
      <a href="/" className="text-blue-600 dark:text-blue-400 underline text-sm">← 検索に戻る</a>

      <div className="mt-4 flex gap-2">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="追加するキーワード"
          maxLength={MAX_KEYWORD_LENGTH}
          className="flex-1 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500"
          onKeyDown={e => {
            if (e.key === 'Enter') add();
          }}
        />
        <button
          onClick={add}
          disabled={submitting}
          className="px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50"
        >
          追加
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <ul className="mt-4 space-y-2">
        {loading && <li>読み込み中…</li>}
        {!loading && keywords.length === 0 && (
          <li className="text-gray-500 dark:text-gray-400">保存キーワードはありません</li>
        )}
        {keywords.map(k => (
          <li
            key={k.id}
            className="flex justify-between items-center border border-gray-200 dark:border-gray-700 rounded px-3 py-2"
          >
            <span>{k.keyword}</span>
            <button
              onClick={() => remove(k.id)}
              className="text-red-600 dark:text-red-400 text-sm"
            >
              削除
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
