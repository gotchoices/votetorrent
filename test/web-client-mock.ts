import { WebClient } from "../src/common/web-client";

export class MockWebClient implements WebClient {
    getResponses: Record<string, any> = {};
    postResponses: Record<string, any> = {};

    async get(url: string): Promise<any> {
        return this.getResponses[url];
    }

    async post(url: string, body: any): Promise<any> {
        return this.postResponses[url];
    }

    // Utility methods to set mock responses
    setGetResponse(url: string, response: any) {
        this.getResponses[url] = response;
    }

    setPostResponse(url: string, response: any) {
        this.postResponses[url] = response;
    }
}
