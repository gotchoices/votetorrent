import { WebClient } from "./web-client";

export class WebClientFetch implements WebClient {
    async get(url: string, headers: Record<string, string> = {}): Promise<any> {
        const response = await fetch(url, { method: 'GET', headers });
        return response.json();
    }

    async post(url: string, body: any, headers: Record<string, string> = {}): Promise<any> {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
        });
        return response.json();
    }
}
