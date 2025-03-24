* Have the NetworkTransactor look for intersections between clusters, rather than arbitrary coordinators.
* Refactor elections/confirmations into rounds (grouping of elections for corrections or for runoffs)
* Resolve case for concurrent collection creation
* Collect signatures digitally
* Potential enhancement: have the peers at or around the block's CID submit the block, to make the source more anonymous
* How to validate that a given voter is coming from a valid CID for that registrar?  Or should we just not and risk a block poisoning DOS attack?
* Allow local storage of nonces for instance to be located in backup storage
* Add Atomic() wrappers to btree to avoid corruption on errors
* Encode an expiration into a transaction Id to create an outer limit, or at least pass an expiration around
