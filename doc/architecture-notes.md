Option 1 - pessimistic flat 2PC:
* Blocks are independently versioned, with block coordinator - cannot update from stale version
* Transactions contains: modifications and dependencies, which span blocks in general
* A block doesn't have to be dependent to be updated (if update doesn't depend on prior state)
* Phase 1: Transaction submitted to all affected blocks (w/ TTLs)
* Any dependent blocks are locked during transaction coordination
* Phase 2: Responses obtained from all affected blocks - then pushed back out to all affected blocks
* Authorization at block level requires majority of block transactors
* Transaction across blocks is based on signed 2CP
* Blocks validate other blocks using signatures - surrounding proximity and similar key space resolution seen locally
* TTLs ensure action if coordinator is Byzantine
* Con: Requires locking of dependent blocks during transaction coordination
* Con: Requires separate structure for tree or log of complete collection
* Pro: Simple flat transactions across blocks

Option 2 - optimistic with collection log (like AliveBase):
* Each collection maintains log of logical transactions, each with:
  * number (LTN), random ID, block IDs and hashes, and public key of the transactor
* Logical log stored physically in linked list queue of blocks
* Blocks store the collection they are part of
* Blocks (including log blocks) versioned by the LTN of which they are part - cannot post from stale version
* Phase 1: `pending update`s are posted to all affected blocks (w/ TTLs) - these don't update the revision, though `get`s can explicitly mention them
* Phase 2: Transaction tail is appended to, obtaining a revision number
* Phase 3: All affected blocks are updated using the new LTN - pending becomes actual and permanent
* Checkpoint LTN is stored in collection header block along with transaction head and tail
* Background process sweeps from checkpoint LTN to tail LTN, verifying that all affected blocks have applied that transaction - checkpoint updated
* Authorization at cross-block level requires logical record and signatures from log block transactors
* Cross-collection transactions nest this design - transaction log included in pending update
* Con: transient hotspot for log tail block
* Pro: No locks within a collection
* Pro: Logical log included
