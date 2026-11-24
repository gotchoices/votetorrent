export interface RawStorageLike {
  close?(): Promise<void>
}

export interface ScopedStorage<S extends RawStorageLike> {
  provider(scope: string): S
  destroyScope(scope: string): Promise<void>
  closeStores(): Promise<void>
  scopes(): string[]
}

export function createScopedStorage<S extends RawStorageLike>(_peerDir: string, _FileRawStorage: new (basePath: string) => S): ScopedStorage<S> {
  throw new Error('unimplemented')
}
