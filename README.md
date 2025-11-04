# VoteTorrent
Crowd voting protocol and reference application.

## ⚠️ SECURITY WARNING - NOT PRODUCTION READY ⚠️

**This codebase is currently under active development and is NOT ready for production use.**

Critical security features are being implemented as part of a comprehensive security hardening initiative. Do NOT deploy this system for any real elections or production use cases until:

1. ✅ All Phase 1-5 security improvements are complete (see [Modernization Plan](doc/modernization-plan.md))
2. ✅ Third-party security audit has been conducted and all findings addressed
3. ✅ Full test coverage (>80%) has been achieved
4. ✅ Production deployment certification has been issued

**Current Status:**
- Phase 1: Critical Security Hardening (✅ COMPLETE)
  - ✅ Hardware-backed secure storage (iOS Keychain, Android Keystore)
  - ✅ Cryptographically secure operations (proper RNG, encoding, hashing)
  - ✅ Input validation with comprehensive schemas (XSS, injection prevention)
  - ✅ Structured logging with sensitive data redaction
  - ✅ Biometric + PIN authentication system
  - ✅ Removed hardcoded test data and keys
- Phase 2: Architectural Refactoring (PENDING)
- Expected Production Ready: Q3 2026 (pending resource allocation)

For more details, see the [Security Audit](doc/security-audit.md) and [Review Summary](doc/review-summary.md).

---

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
* VoteTorrent Authority ([android APK](https://votetorrent.org/authority.apk))

These will be available in the Apple App Store and Google Play Store.

## Contributing

If you would like to help out, the following skills will be most useful:

* Typescript
* Node.js
* React Native
* libp2p

We can always use help with documentation, testing, translation, and other tasks.

Submit pull requests to the [VoteTorrent repository](https://github.com/gotchoices/votetorrent)
