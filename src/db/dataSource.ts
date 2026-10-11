import pg from "pg";

/**
 * Тонкий data-source слой поверх pg. Репозитории зависят только от
 * интерфейсов Queryable/DataSource — в тестах подставляется in-memory
 * фейк (см. tests/helpers/fakeDataSource.ts), интеграционные тесты —
 * PostgresDataSource. Это единственная точка, знающая про pg.
 */

export interface QueryResult<T = unknown> {
  rows: T[];
  rowCount: number | null;
}

export interface Queryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface DataSource extends Queryable {
  /** Выполнить fn в транзакции: COMMIT при успехе, ROLLBACK при ошибке. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class PostgresDataSource implements DataSource {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  query<T = unknown>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
    return this.pool.query(text, params) as unknown as Promise<QueryResult<T>>;
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tx: Queryable = {
        query: <R = unknown>(text: string, params?: unknown[]) =>
          client.query(text, params) as unknown as Promise<QueryResult<R>>,
      };
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Удобный конструктор из DATABASE_URL (без секретов в коде). */
export function createDataSource(databaseUrl?: string): DataSource {
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set (see .env.example)");
  }
  return new PostgresDataSource(url);
}
