export const AREAS = [
  '関東', '近畿', '東海', '北海道/東北', '北陸', '中国/四国', '九州/沖縄',
] as const;
export type Area = typeof AREAS[number];

const AREA_TO_PREFS: Record<Area, string[]> = {
  '関東':       ['東京都','神奈川県','埼玉県','千葉県','茨城県','栃木県','群馬県'],
  '近畿':       ['大阪府','京都府','兵庫県','奈良県','滋賀県','和歌山県'],
  '東海':       ['愛知県','岐阜県','三重県','静岡県'],
  '北海道/東北': ['北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県'],
  '北陸':       ['新潟県','富山県','石川県','福井県','長野県','山梨県'],
  '中国/四国':   ['岡山県','広島県','鳥取県','島根県','山口県','香川県','徳島県','愛媛県','高知県'],
  '九州/沖縄':   ['福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'],
};

const PREF_TO_AREA: Record<string, Area> = (() => {
  const map: Record<string, Area> = {};
  for (const area of AREAS) for (const p of AREA_TO_PREFS[area]) map[p] = area;
  return map;
})();

export function prefectureToArea(prefecture: string): Area | null {
  return PREF_TO_AREA[prefecture] ?? null;
}

export function prefecturesInArea(area: Area): string[] {
  return [...AREA_TO_PREFS[area]];
}
