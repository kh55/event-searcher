const ONLINE_KEYWORDS = [
  '配信', 'オンライン', 'ライブビューイング', '生配信',
  'LIVE STREAMING', 'online',
];

export function isOnlineEvent(input: {
  title: string;
  description?: string;
  venueName?: string;
}): boolean {
  const haystack = [input.title, input.description, input.venueName]
    .filter(Boolean).join(' ').toLowerCase();
  return ONLINE_KEYWORDS.some(k => haystack.includes(k.toLowerCase()));
}
