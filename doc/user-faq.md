**Q:** What is Votetorrent?

**A:** Votetorrent is a platform for convenient, accurate, transparent, verifiable, and secure voting based on a peer-to-peer network

-----

**Q:** What is a peer-to-peer network?

**A:** Peer-to-peer (P2P) is a technology, where participants connect to each other, rather than to a central authority.  This technology was popularized for file sharing by Bittorrent, and is used for digital currencies like Bitcoin and Etherium.

-----

**Q:** Why use P2P for voting?

**A:** This technology allows voters to pool their votes together (anonymously) and submit votes in scrambled blocks.  The votes are encrypted so other voters don't know what their peers voted for, and the scrambling of the blocks prevents the authority from knowing who voted for whom.

-----

**Q:** How is this transparent, when everything is encrypted?

**A:** Each vote has a secret key that the voter's app generates.  The resulting votes are all made public, and each voter can verify that the secret key is in the set of votes and that the associated vote matches the voter's selection.  The voter can also verify that the voter's record is included.  Anyone can also audit that there are exactly as many votes as voters, and that all voter records are in the registered voter set.

-----

**Q:** What if the authority is unresponsive during voting, or incorrectly manages the votes?

**A:** After votes are submitted, there is a period of verification performed by the peer to peer network.  Disenfranchised voters, validation errors, and any other inconsistencies are amalgamated (with supporting evidence) to produce a P2P confidence report associated with the vote.

-----

**Q:** Why do I have to use biometrics?

**A:** Biometrics, which are built into most smart phones, tablets, and many computers, tie the registration to a particular piece of hardware.  This makes it more difficult to steal, purchase, or mass manipulate votes.  This makes it possible for voting to inherit whatever level of scrutiny is taken at registration time, because there is a high level of confidence that the same device, and same person are voting.

-----

**Q:** Will the authority get my biometrics?

**A:** No.  The biometrics are used locally on the device to authorize a tamper-proof chip called a Trusted Platform Module (TPM) or Secure Enclave.  This module holds a private key in the device's hardware, which is used to digitally sign the vote.  Only the digital signature, is sent to the authority.  The authority, and others who are auditing the election, can verify that only you could have produced the digital signature.

-----

**Q:** Can't someone just hack the app and vote for me, or change my vote?

**A:** No.  Your vote is only valid when signed using your private key, contained within the hardware enclave.  Even with your biometrics, the enclave will not give the device or its user the private key, it will only apply a signature for you that is unique to some content (e.g. the vote).  A hacker would have to manipulate the biometric hardware on the device, which is difficult to do on a small scale, let alone a large scale.

-----

**Q:** Can my peers know how I voted?

**A:** No.  Your vote and voter entries are encrypted so that only the authority can decipher them, and are presented to peers in scrambled order.  The final block of votes and voters are further scrambled before submitting the block to the authority.  At best, the authority can only determine a probability of your vote being something based on the number of votes in a given block.

-----

**Q:** What if the authority's private key were leaked or stolen?

**A:** The worst case for this scenario would be that, if the submitted blocks could also be intercepted, an analyst could determine, based on the size and vote distribution of each block, a statistical likelihood of each voter having voted a certain way.  If the key were leaked back to voters, this would be a way for the voter, within the participated in block, to make this same probabilistic analysis for their peers.

-----

**Q:** Can a peer mess up a block and keep voters in that block from voting?

**A:** Only for a moment.  A voter can, for instance, submit a duplicate vote, which will cause the entire block to be rejected.  But the app will simply and automatically re-form a new block for the voters, excluding the duplicate or problematic voter, and re-submit.  Peer failure activity is "whispered" between peers, so bad actors are eventually black-listed.
