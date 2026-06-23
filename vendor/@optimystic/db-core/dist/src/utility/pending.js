export class Pending {
    promise;
    response;
    error;
    t1 = Date.now();
    duration;
    get isResponse() {
        return this.response !== undefined;
    }
    get isError() {
        return this.error !== undefined;
    }
    get isComplete() {
        return this.isResponse || this.isError;
    }
    async result() {
        if (this.isResponse) {
            return this.response;
        }
        if (this.isError) {
            throw this.error;
        }
        return await this.promise;
    }
    constructor(promise) {
        this.promise = promise;
        promise.then(response => {
            this.duration = Date.now() - this.t1;
            this.response = response;
            return response;
        }, error => {
            this.duration = Date.now() - this.t1;
            this.error = error;
        });
    }
}
//# sourceMappingURL=pending.js.map