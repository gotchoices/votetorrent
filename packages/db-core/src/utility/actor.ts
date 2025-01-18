type AsyncMethodKeys<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => any ? K : never
}[keyof T];

type Actor<T> = {
  [K in AsyncMethodKeys<T>]:
    T[K] extends (...args: infer A) => infer R
      ? (...args: A) => Promise<Awaited<R>>
      : never;
} & {
  // pass through property reads
  [K in Exclude<keyof T, AsyncMethodKeys<T>>]: T[K];
};

// makes an actor-like proxy around any object
export function createActor<T extends object>(target: T): Actor<T> {
  // a queue of calls waiting to run
  const callQueue: Array<{
    method: keyof T;
    args: unknown[];
    resolve: (val: unknown) => void;
    reject: (err: unknown) => void;
  }> = [];

  let running = false;

  async function runQueue() {
    if (running) return;
    running = true;

    while (callQueue.length > 0) {
      const { method, args, resolve, reject } = callQueue.shift()!;

      try {
        // call method on the original target
        const result = (target[method] as any)(...args);
        // if it’s a promise, await it; otherwise just pass it back
        const awaited = result instanceof Promise ? await result : result;
        resolve(awaited);
      } catch (err) {
        reject(err);
      }
    }

    running = false;
  }

  return new Proxy(target, {
    get(_obj, prop, _receiver) {
      const value = (target as any)[prop];
      // if it’s not a function, pass it through directly (optional)
      if (typeof value !== 'function') return value;

      // otherwise return a function that queues the call
      return (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          callQueue.push({ method: prop as keyof T, args, resolve, reject });
          runQueue();
        });
    },
  }) as Actor<T>;
}
