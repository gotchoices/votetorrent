**Q:** What is Votetorrent?

**A:** Votetorrent is a platform for convenient, accurate, transparent, verifiable, and secure voting based on a peer-to-peer network

-----

**Q:** What is a peer-to-peer network?

**A:** Peer-to-peer (P2P) is a technology, where participants connect to each other, rather than to a central authority.  This technology was popularized for file sharing by Bittorrent, and is used for digital currencies like Bitcoin and Etherium.

-----

**Q:** Why use P2P for voting?

**A:** This technology allows voters to self-organize and pool their votes together (anonymously) and submit votes in scrambled blocks.  The votes are encrypted and scrambled so other peers, the authority, any other observers don't know how each voter voted.

-----

**Q:** How is this transparent, when everything is encrypted?

**A:** Each vote has a secret code that the voter's app generates.  When all the election votes are made visible, each voter can verify that the secret code is in the set of votes and that the associated vote matches the voter's selections.  The voter also verifies that the voter's record, indicating that he or she voted, is included.  Anyone can check that all votes are appropriately signed, only registered voters voted, and that there are exactly as many votes as voters.

-----

**Q:** What keeps observers from being able to determine which way the result is going, before the election is finalized?

**A:** The vote and voter contents are encrypted using a compound key held by a set of parties, disclosed in the terms of the elections.  It takes a certain number of private keys, held by these parties, in order to be able to decrypt the results of the election, so no single party can prematurely reveal the election results until the agreed upon time window.

-----

**Q:** What if the private keys for the election are leaked or lost?

**A:** Election keys are meant to be held by multiple parties, but they neutral parties, or those with opposing stakes in the election outcome. If an election key is leaked, and an observer or peer comes in contact with it, the released key along with a signed timestamp can be immediately captured as an anomaly for the validation report.  Even still, only if the required number of disclosed keys is reached can the election results be prematurely decrypted.  If keys are lost, the election can still be completed so long as the required number of disclosed keys is met.

-----

**Q:** What if a voter is unable to reach peers or parts of the network, and is unable to submit a vote, or if the authority doesn't release their keys?

**A:** After votes are submitted, there is a period of validation performed by the peer to peer network.  Disenfranchised voters, validation errors, and any other inconsistencies are amalgamated (with supporting evidence) to produce a P2P confidence report associated with the vote.

-----

**Q:** Why do I have to use biometrics?

**A:** Biometrics, which are built into most smart phones, tablets, and many computers, tie the registration to a particular piece of hardware.  This makes it more difficult to steal, purchase, or mass manipulate votes.  This makes it possible for voting to inherit whatever level of scrutiny is taken at registration time, because there is a high level of confidence that the same device, and same person are voting.

-----

**Q:** Will the authority get my biometrics?

**A:** No.  The biometrics are used locally within the device to interface with a tamper-proof chip called a Trusted Platform Module (TPM) or Secure Enclave.  This module holds a private key in the device's hardware, which is used to digitally sign the vote.  Even the device's operating system does not have access to the private key.  Only the digital signature, is sent to the authority.  The authority, and others who are auditing the election, can verify that only that device could have produced the digital signature.

-----

**Q:** Can't someone just hack the app and vote in my stead, or change my vote?

**A:** No.  Your vote is only valid when signed using your private key, contained within your phone's hardware.  Even if someone stole your fingerprint, for instance, they would not be able to sign your vote because they do not have your private key.  A hacker would have to fake or manipulate the biometric hardware on your device.  Doing this on a large scale is difficult, and doing so would violate all sorts of security assumptions being used by banks and other security sensitive organizations.

-----

**Q:** Can my peers know how I voted?

**A:** Generally no.  Your vote and voter entries are encrypted and scrambled with others in such a way that even your peers do not know which vote record goes with your voter record.  Only when the designated parties release their public keys, will observers be able to decipher the scrambled order votes.  At best, peers and observers can only determine a probability of your vote being something based on those votes in the block.  Only if all votes within a given block are the same, can a particular way of voting be ascertained for a voter.

-----

**Q:** Can a peer mess up a block and keep voters in that block from voting?

**A:** Only for a moment.  A voter can, for instance, submit a duplicate vote, which will cause the entire block to be invalid.  But the app will simply and automatically re-form a new block for the voters, excluding the duplicate or problematic voter, and re-submit it.  Peer failure activity is "whispered" between peers, so bad actors are eventually black-listed.
