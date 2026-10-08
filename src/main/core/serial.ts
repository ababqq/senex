/**
 * Run `action` after whatever is already queued under `key`, one at a time per key: two loads of
 * one preview handle, two shows of one project or two cover renders never interleave. A failure of
 * the one before does not stop the next; the queue entry is dropped once the last one settles.
 */
export async function serial<T>(
  queue: Map<string, Promise<unknown>>,
  key: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = queue.get(key);
  const next = (previous ?? Promise.resolve()).catch(() => {}).then(action);
  queue.set(key, next);
  try {
    return await next;
  } finally {
    if (queue.get(key) === next) queue.delete(key);
  }
}
