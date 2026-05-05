export interface SearchInput {
  q: string;
  from: Date;
  to: Date;
  areas: string[];
  includeOnline: boolean;
  onSaleOnly: boolean;
}

export interface QueryParams {
  q: string;
  fromIso: string;
  toIso: string;
  areas: string[] | null;
  includeOnline: boolean;
  onSaleOnly: boolean;
}

export function buildSearchQueryParams(input: SearchInput): QueryParams {
  return {
    q: input.q ?? '',
    fromIso: input.from.toISOString(),
    toIso: input.to.toISOString(),
    areas: input.areas.length > 0 ? input.areas : null,
    includeOnline: !!input.includeOnline,
    onSaleOnly: !!input.onSaleOnly,
  };
}
