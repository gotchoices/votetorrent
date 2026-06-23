// makes an actor-like proxy around any object
export function createActor(target) {
    // a queue of calls waiting to run
    const callQueue = [];
    let running = false;
    async function runQueue() {
        if (running)
            return;
        running = true;
        while (callQueue.length > 0) {
            const { method, args, resolve, reject } = callQueue.shift();
            try {
                // call method on the original target
                const result = target[method](...args);
                // if it’s a promise, await it; otherwise just pass it back
                const awaited = result instanceof Promise ? await result : result;
                resolve(awaited);
            }
            catch (err) {
                reject(err);
            }
        }
        running = false;
    }
    return new Proxy(target, {
        get(_obj, prop, _receiver) {
            const value = target[prop];
            // if it’s not a function, pass it through directly (optional)
            if (typeof value !== 'function')
                return value;
            // otherwise return a function that queues the call
            return (...args) => new Promise((resolve, reject) => {
                callQueue.push({ method: prop, args, resolve, reject });
                runQueue();
            });
        },
    });
}
//# sourceMappingURL=actor.js.map