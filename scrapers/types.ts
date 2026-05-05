import type { TicketStatus } from '@/lib/ticket-status';
import type { FetchHtmlOptions } from './http';

export interface SearchParams {
  keyword?: string;
  dateFrom: Date;
  dateTo: Date;
  prefectures?: string[];
  includeOnline: boolean;
}

export interface RawEvent {
  sourceEventId: string;
  title: string;
  description?: string;
  startsAt: Date;
  endsAt?: Date;
  venueName?: string;
  prefecture?: string;
  isOnline: boolean;
  ticketUrl?: string;
  ticketStatus: TicketStatus;
  performers: string[];
  tags: string[];
}

export interface SourceAdapter {
  readonly source: string;
  search(params: SearchParams, opts?: FetchHtmlOptions): Promise<RawEvent[]>;
}
