/** Subset of D1 used by the archive. Tests implement it with node:sqlite. */

export interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
}

export interface ArchiveDb {
  prepare(query: string): PreparedStatement;
}
