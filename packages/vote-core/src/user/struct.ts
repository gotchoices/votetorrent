import type { ImageRef } from "../common/image-ref";
import type { Timestamp } from "../common/timestamp";
import type { Signature } from "../common/signature";

export type User = {
  sid: string;
  name: string;
  image: ImageRef;
  activeKeys: UserKey[];
};

export type DefaultUser = {
  name: string;
  image: ImageRef;
};

export type UserKey = {
  key: string;
  type: UserKeyType;
  expiration: Timestamp;
};

export enum UserKeyType {
  mobile = 'M',
  yubico = 'Y'
}

export type UserHistory = {
  event: UserHistoryEvent;
  timestamp: Timestamp;
  signature: Signature;
}

export type CreateUserHistory = UserHistory & {
  event: UserHistoryEvent.create;
  info: UserInfo;
  userKey: UserKey;
}

export type RevokeUserKeyHistory = UserHistory & {
  event: UserHistoryEvent.revokeKey;
  key: string;
}

export type AddUserKeyHistory = UserHistory & {
  event: UserHistoryEvent.addKey;
  userKey: UserKey;
}

export type ReviseUserHistory = UserHistory & {
  event: UserHistoryEvent.revise;
  info: UserInfo;
}

export type UserInfo = {
  name: string;
  image: ImageRef;
}

export enum UserHistoryEvent {
  create = 'C',
  revise = 'R',
  addKey = 'AK',
  revokeKey = 'RK',
}

export type DeviceAdvertisement = {
  multiAddress: string;
  token: string;
}
