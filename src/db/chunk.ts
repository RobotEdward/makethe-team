/**
 * Rows per INSERT statement.
 *
 * D1 rejects a statement with more than 100 bound parameters (TR-38). The
 * effective row ceiling depends on the table's column count, and Drizzle may
 * bind more parameters per row than there are declared columns — so this is a
 * deliberately conservative constant rather than something computed. Measured:
 * `fixtures` failed at 10 rows per statement and succeeded at 9.
 *
 * Chunking means a mid-way failure can leave earlier chunks written. Every
 * caller must therefore be idempotent, so a retry completes the work rather
 * than duplicating it.
 */
export const INSERT_CHUNK_SIZE = 8;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
