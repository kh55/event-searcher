'use client';

interface Event {
  id: number;
  title: string;
  starts_at: string;
  venue_name?: string;
  prefecture?: string;
  is_online: boolean;
  ticket_status: string;
  ticket_url?: string;
  source: string;
  performers: string[];
}

const STATUS_LABELS: Record<string, { text: string; color: string }> = {
  on_sale:  { text: '販売中',       color: '#10b981' },
  lottery:  { text: '抽選受付中',   color: '#f59e0b' },
  sold_out: { text: 'SOLD OUT',     color: '#ef4444' },
  ended:    { text: '販売終了',     color: '#6b7280' },
  unknown:  { text: '状態不明',     color: '#9ca3af' },
};

export function ResultCard({ event }: { event: Event }) {
  const status = STATUS_LABELS[event.ticket_status] ?? STATUS_LABELS.unknown;
  const date = new Date(event.starts_at);
  // 時刻が JST 0:00 (= UTC 15:00 前日) の場合は日付のみ表示
  const isMidnight =
    date.getUTCHours() === 15 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0;
  const dateStr = isMidnight
    ? date.toLocaleString('ja-JP', { dateStyle: 'medium' })
    : date.toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="border rounded-md p-3 mb-2 bg-white">
      <div className="flex justify-between text-xs text-gray-500">
        <span>{dateStr}</span>
        <span
          style={{ background: status.color }}
          className="text-white px-2 py-0.5 rounded-full"
        >
          {status.text}
        </span>
      </div>
      <div className="font-semibold mt-1">{event.title}</div>
      <div className="text-sm text-gray-700">
        {event.is_online
          ? 'オンライン'
          : `${event.prefecture ?? ''} / ${event.venue_name ?? ''}`}
      </div>
      {event.performers.length > 0 && (
        <div className="text-xs text-gray-600 mt-1">
          出演: {event.performers.join(', ')}
        </div>
      )}
      <div className="flex gap-2 mt-2 items-center">
        {event.ticket_url && (
          <a
            href={event.ticket_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 underline"
          >
            チケットページ →
          </a>
        )}
        <span className="text-xs text-gray-400">via {event.source}</span>
      </div>
    </div>
  );
}
