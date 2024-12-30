export interface WebClient {
    get(url: string, headers?: Record<string, string>): Promise<any>;
    post(url: string, body: any, headers?: Record<string, string>): Promise<any>;
}
