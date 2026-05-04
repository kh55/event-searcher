'use client';
import { useEffect, useState } from 'react';

interface SavedKeyword { id: number; keyword: string; created_at: string; }

export default function SettingsPage() {
  const [keywords, setKeywords] = useState<SavedKeyword[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const res = await fetch('/api/saved-keywords');
    const data = await res.json();
    setKeywords(data.keywords ?? []);
    setLoading(false);
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
      <a href="/" className="text-blue-600 underline text-sm">← 検索に戻る</a>
      <ul className="mt-4 space-y-2">
        {loading && <li>読み込み中…</li>}
        {!loading && keywords.length === 0 && <li className="text-gray-500">保存キーワードはありません</li>}
        {keywords.map(k => (
          <li key={k.id} className="flex justify-between items-center border rounded px-3 py-2">
            <span>{k.keyword}</span>
            <button onClick={() => remove(k.id)} className="text-red-600 text-sm">削除</button>
          </li>
        ))}
      </ul>
    </main>
  );
}
