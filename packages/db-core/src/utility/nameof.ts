/* eslint-disable no-redeclare, @typescript-eslint/explicit-module-boundary-types, @typescript-eslint/no-explicit-any */
export function nameof<TObject>(obj: TObject, key: keyof TObject): string;
export function nameof<TObject>(key: keyof TObject): string;
export function nameof(key1: any, key2?: any): any {
  return key2 ?? key1;
}
/* eslint-enable */
