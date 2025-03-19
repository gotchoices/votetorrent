# db-p2p - libp2p integration of Optimystic data layer

This integration involves the following components:

* Libp2p Node Creation - createLibp2pNode() sets up a properly configured libp2p node instance
* Libp2pKeyPeerNetwork - class that implements IKeyNetwork and IPeerNetwork on libp2p
* ProtocolClient - Base class for clients that communicate via a libp2p protocol
* RepoClient - Implements a repo that communicates to a remote RepoService
* RepoService - Receives repo messages and routes them to a local repo
* CoordinatorRepo - Cluster coordination repo - uses local store, as well as distributes changes to other nodes using cluster consensus.
* ClusterTransactionManager - Manages distributed transactions across clusters for each operation
* ClusterClient - Implements a cluster that communicates to a remote ClusterService
* ClusterService - Receives cluster messages and routes them to a local cluster handler
* ClusterRepo - Handles cluster member behavior coming from a coordinator and when actions reach consensus, passes on the action to the storage repo
* StorageRepo - Implements repo using BlockStorage
* BlockStorage - Manages a single block's storage, using a set of RawStorage commands
* FileStorage - Implements RawStorage using a filesystem

