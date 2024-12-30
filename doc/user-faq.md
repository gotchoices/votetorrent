**Q:** What is VoteTorrent?

**A:** VoteTorrent is a platform for convenient, accurate, transparent, verifiable, and secure voting based on a peer-to-peer network

-----

**Q:** What is a peer-to-peer network?

**A:** Peer-to-peer (P2P) is a technology, where participants connect to each other, rather than to a central authority.  This technology was popularized for file sharing by Bittorrent, and is used for digital currencies like Bitcoin and Etherium.

-----

**Q:** Why use P2P for voting?

**A:** This technology allows voters to self-organize and pool their votes together (anonymously) and submit votes in compiled blocks.  The votes are encrypted and scrambled so other peers, authorities, any other observers don't know how each voter voted.

-----

**Q:** How is this transparent, when everything is encrypted?

**A:** Each vote has a secret code that the voter's app generates.  When all the election votes are made visible, each voter can verify that the vote, with its secret code, is present in the published votes.  The voter also verifies that the voter's record, indicating that he or she voted, is included.  Anyone can check that all votes are appropriately signed, only registered voters voted, and that there are exactly as many votes as voters.

-----

**Q:** What keeps observers from being able to determine which way the result is going, before the election is finalized?

**A:** The vote and voter record contents are encrypted using a compound key held by a set of parties, disclosed in the terms of the election.  It takes a certain set of private keys, held by these parties, in order to decrypt the results of the election, so no single party can prematurely reveal the election results until the agreed upon time window.

-----

**Q:** What if the private keys for the election are leaked?

**A:** Election keys are meant to be held by multiple, neutral parties, or those with opposing stakes in the election outcome. If an election key is leaked, and an observer or peer comes in contact with it, the released key along with a signed timestamp can be immediately captured, and submitted as evidence of an anomaly in the collective validation report.  Even still, only if the required number of disclosed keys is reached can the election results be prematurely decrypted.

-----

**Q:** What if a key is lost?

**A:** If any key is lost or intentionally withheld, the election must be re-ran, so it is important to keep the keys secure, and it is recommended to have multiple, safely secured copies of each key.

-----

**Q:** What if a voter is unable to reach peers or parts of the network, and is unable to submit a vote, or if the authority doesn't release their keys?

**A:** After votes are submitted, there is a period of validation, performed by the peers in the network.  Disenfranchised voters, validation errors, and any other inconsistencies are amalgamated (with supporting evidence) to produce a P2P confidence report associated with the vote.

-----

**Q:** Why do I have to use biometrics?

**A:** VoteTorrent doesn't necessarily require them, but biometrics are highly recommended and can be required as part of the election terms.  Biometrics, which are built into most smart phones, tablets, and many computers, tie the registration to a particular piece of hardware.  This makes it more difficult to steal, purchase, or mass manipulate votes.  This makes it possible for voting to inherit whatever level of scrutiny is taken at registration time, because there is a high level of confidence that the same device, and same person are voting.

-----

**Q:** Will the authority get my biometrics?

**A:** No.  The biometrics are used locally within the device to interface with a tamper-proof chip called a Trusted Platform Module (TPM) or Secure Enclave.  This module holds a private key in the device's hardware, which is used to digitally sign the vote.  Even the device's operating system does not have access to the private key.  Only a digital signature, is sent to the peers or authority.  The authority, and others who are auditing the election, can verify that only *that* device could have produced the digital signature.

-----

**Q:** Can't someone just hack the app and vote in my stead, or change my vote?

**A:** No.  Your vote is only valid when signed using your private key, contained within your phone's hardware.  Even if someone stole your fingerprint, for instance, they would not be able to sign your vote because they do not have your private key.  A hacker would have to fake or manipulate the biometric hardware on your device.  Doing this on a large scale is difficult, and doing so would violate all sorts of security assumptions being used by banks, security services, and other sensitive organizations.

-----

**Q:** Can my peers know how I voted?

**A:** Generally no.  Your vote and voter entries are encrypted and scrambled with others in such a way that even your peers do not know which vote record goes with your voter record.  Only when the designated parties release their public keys, will observers be able to decipher the scrambled order votes.  At best, peers and observers can only determine a probability of your vote being something based on those votes in the block.  Only if all votes within a given block are the same, can a particular way of voting be definitively ascertained for a voter.

-----

**Q:** Can a peer mess up a block and keep voters in that block from voting?

**A:** Only temporarily.  A voter can, for instance, submit a duplicate vote, which will cause the forming block to be invalid.  But the other peers will simply and automatically re-form a new block, excluding the duplicate or problematic voter.  Further, peer failure activity is "whispered" between peers, so bad actors are eventually black-listed.
