import type { Pool, PoolConnection } from "mysql2/promise";

export type TransactionHandler<T> = (connection: PoolConnection) => Promise<T>;

export async function withTransaction<T>(
  pool: Pool,
  handler: TransactionHandler<T>
): Promise<T> {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const result = await handler(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
