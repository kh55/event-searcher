/**
 * Pool 互換の最小 fake。`pool.query(sql, params)` 呼び出しを記録し、
 * 事前に enqueue した結果を順番に返す。
 */
import type { Pool, QueryResult, QueryResultRow } from 'pg';

interface RecordedCall {
  sql: string;
  params: readonly unknown[] | undefined;
}

export interface MockPool extends Pick<Pool, 'query'> {
  calls: readonly RecordedCall[];
  enqueue<R extends QueryResultRow = QueryResultRow>(result: Partial<QueryResult<R>>): void;
}

export function createMockPool(): MockPool {
  const calls: RecordedCall[] = [];
  const queue: Partial<QueryResult>[] = [];

  return {
    calls,
    enqueue(result) {
      queue.push(result as Partial<QueryResult>);
    },
    query: (async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params });
      const next = queue.shift();
      const rows = (next?.rows as readonly unknown[] | undefined) ?? [];
      return {
        rows,
        rowCount: next?.rowCount ?? rows.length,
        command: next?.command ?? 'SELECT',
        oid: next?.oid ?? 0,
        fields: next?.fields ?? [],
      } as QueryResult;
    }) as Pool['query'],
  };
}
