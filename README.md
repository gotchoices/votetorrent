# VoteTorrent
Crowd voting protocol and reference application.

See the following documentation:

* [End-user Frequently Asked Questions](doc/user-faq.md)
* [Figma Wireframes](https://www.figma.com/proto/egzbAF1w71hJVPxLQEfZKL/Mobile-App?node-id=53-865&t=b6kRPTs8TXLtsWgk-1)
* [Technical Architecture](doc/architecture.md)
* [Election Logic](doc/election.md)

## How to use:

### Host a stand-alone node

Stand-alone nodes can be hosted on any platform supporting Node.js.  A node can be configured as either of the following:
  * **Transaction** - limited storage
    * Facilitates data storage and matchmaking operations, such as:
      * Registration
      * Voting
      * Validation
  * **Storage** - server or cloud service - long term storage capable
    * User: press, municipalities, etc.
    * Facilitates:
      * Stability and robustness of storage
      * Archival of election results

Whether transactional or storage, a stand-alone node can optionally serve as a:
  * Public IP/DNS address - incoming connections from mobile apps and NAT traversal
  * Bootstrap - stable entry points for the network

### Use the reference app

**Mobile apps coming soon:**
* VoteTorrent Election
* VoteTorrent Authority

These will be available in the Apple App Store and Google Play Store.

## Contributing

If you would like to help out, the following skills will be most useful:

* Typescript
* Node.js
* React Native
* libp2p

We can always use help with documentation, testing, translation, and other tasks.

Submit pull requests to the [VoteTorrent repository](https://github.com/gotchoices/votetorrent)
