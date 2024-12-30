import type { Libp2p } from 'libp2p';
import { DiaryCollection, DiaryEntry } from '@votetorrent/db-core';
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';

export class P2PDiaryCollection extends DiaryCollection {
  private readonly topicName: string;

  constructor(name: string, private readonly node: Libp2p) {
    super(name);
    this.topicName = `/votetorrent/diary/${name}`;
    this.setupPubSub();
  }

  private setupPubSub(): void {
    this.node.services.pubsub.subscribe(this.topicName);
    this.node.services.pubsub.addEventListener('message', (evt: any) => {
      if (evt.detail.topic === this.topicName) {
        const entry = JSON.parse(uint8ArrayToString(evt.detail.data));
        entry.timestamp = new Date(entry.timestamp);
        super.addEntry(entry);
      }
    });
  }

  async addEntry(entry: DiaryEntry): Promise<void> {
    super.addEntry(entry);
    const message = uint8ArrayFromString(JSON.stringify(entry));
    await this.node.services.pubsub.publish(this.topicName, message);
  }

  async getEntries(): Promise<DiaryEntry[]> {
    return super.getEntries();
  }
}
