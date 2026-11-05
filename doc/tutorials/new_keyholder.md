# VoteTorrent Tutorial: Understanding and Managing Keyholders

## Tutorial Goals & Objectives

This tutorial aims to:
- Explain the role of keyholders in the VoteTorrent election system
- Provide guidance on selecting appropriate keyholders for an election
- Outline the critical responsibilities keyholders must fulfill
- Clarify the security practices keyholders should follow
- Help administrators manage the keyholder lifecycle effectively

The tutorial targets both election administrators who need to select and manage keyholders, and individuals who have been invited to serve as keyholders.

## Key model (current design)

- An election invites n keyholders, with a threshold k (2 <= k <= n) set on the election revision. Revealing results needs key share releases from at least k of the n keyholders during the appointed timeframe.
- If keyholders do not perform their duties, up to n - k of them may be absent without blocking the tally. Fewer than k releases simply means results cannot yet be revealed.
- No single keyholder, and no device, ever holds the full election private key. Keyholders jointly generate the key through a distributed key generation (DKG) with no trusted dealer, so even the keyholder who proposes the election never sees the whole key.
- Up to k - 1 colluding keyholders learn nothing about the election private key, before or after release. Collusion among fewer than the threshold cannot unlock results early.
- What a keyholder releases, when their turn comes, is their one key share — not the election private key itself. A single released share reveals nothing on its own.
- Once at least k shares are public, anyone can verify each share against the published commitments and reconstruct the election private key themselves — the authority does not perform a special reconstruction step on anyone's behalf.

## Key Questions to Address

### Essential Understanding
- What is a keyholder and why are they important to election security?
- How do keyholders differ from administrators?
- How many keyholders are needed for an election and why?
- What happens if keyholders don't perform their duties?

### Keyholder Selection & Management
- Who makes good candidates for the keyholder role?
- What should keyholders know before accepting the responsibility?
- How are keyholders invited and how do they accept their role?
- When and how do keyholders release their private keys?

### Security Best Practices
- What security measures should keyholders follow?
- What happens if a keyholder loses access to their device?
- What contingency plans should be in place for keyholder unavailability?
- What documentation should be maintained regarding keyholders?

### Fundamentals
- What is a keyholder in the VoteTorrent system?
- Why does VoteTorrent use keyholders for elections?
- What cryptographic concepts underpin the keyholder model?

### Keyholder Responsibilities
- What specific duties do keyholders perform?
- What is the time commitment required from keyholders?
- What actions must keyholders take during different election phases?
- What happens if a keyholder fails to fulfill their responsibilities?

### Security and Trust
- How are keyholder credentials secured?
- What devices should keyholders use to perform their duties?
- How do keyholders protect their private keys?
- What happens if a keyholder loses access to their device or credentials?
- What security practices should keyholders follow?

### Keyholder Lifecycle
- Can keyholders be replaced during an election if necessary?
- What happens after an election concludes - do keyholders have ongoing responsibilities?

### Practical Implementation
- How does a keyholder interact with the VoteTorrent app?
- What is the user experience like for the keyholder?
- What notifications or reminders do keyholders receive?
- How do keyholders verify that they're performing actions correctly?

### Contingency Planning
- What happens if a keyholder is unavailable at a critical moment?
- How many keyholders can be "missing" before the election is compromised?
- Can backup keyholders be designated?
- What procedures exist for emergency keyholder replacement?

### Legal and Ethical Considerations
- What are the legal implications of serving as a keyholder?
- Are there liability concerns for keyholders?
- Should keyholders sign agreements or take oaths?
- How are privacy and confidentiality maintained?

### Best Practices
- What are the recommended best practices for keyholder management?
- How should keyholders be trained and prepared?
- How should communication with keyholders be handled?
- What documentation should be maintained regarding keyholders? 