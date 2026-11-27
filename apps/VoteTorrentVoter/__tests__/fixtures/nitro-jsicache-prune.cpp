// Host check for the react-native-nitro-modules JSICache patch (nitro-jsicache-prune.test.ts).
//
// JSICache keeps one WeakReference per value it converts (every ArrayBuffer passed to a native
// method). Unpatched, those entries were only released in ~JSICache, so each conversion left a
// ReferenceState alive for the life of the runtime. This drives the cache's append exactly as
// JSICacheReference::makeShared does, with a plain `int` in place of a jsi value, and counts the
// ReferenceState allocations still alive.
//
// Build with -DUNPATCHED to run the same steps through the old `push_back` (the red control).
// Needs -fsized-deallocation (clang leaves it off), or the state count below never drops.

#include "BorrowingReference.hpp"
#ifndef UNPATCHED
#include "WeakReferenceCache.hpp"
#endif
#include <cstdio>
#include <cstdlib>
#include <new>
#include <vector>

using namespace margelo::nitro;

static long liveStates = 0;

void* operator new(std::size_t size) {
  void* p = std::malloc(size);
  if (p == nullptr)
    throw std::bad_alloc();
  if (size == sizeof(ReferenceState))
    liveStates++;
  return p;
}
void operator delete(void* p, std::size_t size) noexcept {
  if (p != nullptr && size == sizeof(ReferenceState))
    liveStates--;
  std::free(p);
}
void operator delete(void* p) noexcept {
  std::free(p);
}

template <typename T>
static void append(std::vector<WeakReference<T>>& cache, WeakReference<T>&& ref) {
#ifdef UNPATCHED
  cache.push_back(std::move(ref));
#else
  appendPruningExpired(cache, std::move(ref));
#endif
}

int main() {
  constexpr int kReleased = 100000;
  constexpr int kLive = 1000;
  std::vector<WeakReference<int>> cache;

  // A native call per value: convert, use, release (what a Hash.update(buffer) loop does).
  for (int i = 0; i < kReleased; i++) {
    BorrowingReference<int> owning(new int(i));
    append(cache, owning.weak());
  }
  const std::size_t sizeAfterReleased = cache.size();
  const long statesAfterReleased = liveStates;

  // Values still held by native code must stay in the cache and stay lockable.
  std::vector<BorrowingReference<int>> held;
  held.reserve(kLive);
  for (int i = 0; i < kLive; i++) {
    held.emplace_back(new int(i));
    append(cache, held.back().weak());
  }
  for (int i = 0; i < kReleased; i++) {
    BorrowingReference<int> owning(new int(i));
    append(cache, owning.weak());
  }
  int lockable = 0;
  for (const auto& entry : cache) {
    if (entry.lock())
      lockable++;
  }
  bool heldIntact = true;
  for (int i = 0; i < kLive; i++) {
    if (!held[i].hasValue() || *held[i] != i)
      heldIntact = false;
  }

  // ~JSICache: destroy whatever is still alive.
  for (const auto& entry : cache) {
    BorrowingReference<int> reference = entry.lock();
    if (reference)
      reference.destroy();
  }
  bool heldDestroyed = true;
  for (const auto& h : held) {
    if (h.hasValue())
      heldDestroyed = false;
  }

  // A mostly-live cache must not be rescanned on almost every append: keep a sliding window of
  // 1000 live values (each append releases the oldest) and count the appends that find the
  // vector full, which is when the prune runs. Without the capacity doubling a prune frees only
  // the few values released since the last one, so the vector refills within a few appends.
  std::vector<WeakReference<int>> liveCache;
  std::vector<BorrowingReference<int>> window;
  constexpr int kWindow = 1000;
  constexpr int kSliding = 20000;
  int fullAppends = 0;
  for (int i = 0; i < kSliding; i++) {
    window.emplace_back(new int(i));
    if (liveCache.size() == liveCache.capacity())
      fullAppends++;
    append(liveCache, window.back().weak());
    if (window.size() > kWindow)
      window.erase(window.begin());
  }

  std::printf("{\"fullAppendsWhileLive\":%d,\"sizeAfterReleased\":%zu,\"statesAfterReleased\":%ld,\"lockable\":%d,\"heldIntact\":%s,"
              "\"heldDestroyed\":%s,\"sizeAtEnd\":%zu}\n",
              fullAppends, sizeAfterReleased, statesAfterReleased, lockable, heldIntact ? "true" : "false",
              heldDestroyed ? "true" : "false", cache.size());
  return 0;
}
