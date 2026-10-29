/** Keep failures from poisoning subsequent validation requests. */
let tail: Promise<unknown> = Promise.resolve();
export function runSerial<T>(fn: () => Promise<T>): Promise<T> {
  const result = tail.then(fn);
  tail = result.catch(() => undefined);
  return result;
}
