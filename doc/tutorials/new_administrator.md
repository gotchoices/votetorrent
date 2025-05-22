# VoteTorrent Tutorial: Understanding Administrators

## Tutorial Goals & Objectives

This tutorial aims to:
- Explain the role and responsibilities of administrators in the VoteTorrent system
- Help primary authorities understand when and why to add additional administrators
- Provide guidance on selecting appropriate administrators for different roles
- Clarify when to remove administrators and the implications of doing so
- Explain how creating a new network impacts existing administrator relationships

The tutorial targets election authorities who need to establish a proper administrative structure for their voting network, particularly those who may be unfamiliar with distributed trust management concepts.

---

## Video Narration Script (Full Version - ~500 words)

[SHOW ADMINISTRATORS SCREEN]

Administrators are the individuals authorized to manage your election network. They verify elections, configure ballot templates, and perform other critical functions. Let's explore what administrators are, why you need them, and how to manage them effectively.

(transition)

[SHOW DIAGRAM OF ADMINISTRATOR HIERARCHY]
In VoteTorrent, an administrator is someone who has been granted specific privileges to act on behalf of an authority. Think of them as election officials, each with defined roles and responsibilities. Administrators can be granted different "scopes" - specific permissions that determine what actions they can take.

All administrators trace back to the primary authority - the organization that created the network. This forms a chain of trust, ensuring that every administrative action is authorized through a verifiable path.

(transition)

Why create additional administrators? [SHOW REASONS LIST]

First, for security through separation of duties. No single person should have complete control over an election. Multiple administrators create checks and balances, where critical actions require approval from more than one person.

Second, for operational resilience. If a sole administrator is unavailable during a critical moment, the entire election could be jeopardized. Multiple administrators ensure continuity.

Third, for specialized expertise. Different administrators can focus on specific aspects of the election - some on voter registration, others on ballot design, and others on certification.

(pause)

[SHOW ADMINISTRATOR SELECTION CRITERIA]
Who should serve as your administrators? Choose individuals who:

Are trusted members of your organization with a solid understanding of election procedures. Ideally, they should represent different departments or interests to prevent conflicts.

Match administrators to appropriate scopes based on their roles. For example, your IT security officer might manage key security scopes, while your election director handles ballot template approvals.

Remember that administrators with the "UpdateAdministration" scope can modify the administration itself, including adding or removing other administrators. This is a powerful privilege that should be granted carefully.

(transition)

When should you remove an administrator? [SHOW REMOVAL SCENARIOS]

First, when they no longer serve in the relevant role within your organization. When someone changes positions or leaves the organization, promptly revoke their administrative access.

Second, if there's any suspicion of compromise. If you believe an administrator's credentials may have been compromised, immediately remove them and create new administrative credentials.

Third, when restructuring your administrative model. As your election operations mature, you might need to realign administrative responsibilities.

(pause)

[SHOW NETWORK CREATION IMPACT DIAGRAM]
What happens to administrators if you create a new network? 

Creating a new network establishes a completely separate system with its own primary authority. Existing administrators from your previous network have no automatic privileges in the new network - they must be explicitly added again.

Think of it as moving to a new building - you need to issue new keys to everyone, even if they had keys to the old building. The new network creates a clean slate for administrative structure.

(transition)

[SHOW ADMINISTRATOR BEST PRACTICES]
Best practices for administrator management include:
- Regularly review your administrator list and their privileges
- Implement a "minimum necessary privilege" policy for each administrator
- Establish clear procedures for administrator succession
- Document the purpose and scope of each administrator role
- Require multi-administrator approval for critical actions

Remember that proper administrator management is fundamental to maintaining the security and integrity of your election network.

---

## Video Narration Script (Concise Version - ~250 words)

[SHOW ADMINISTRATORS SCREEN]

Administrators are individuals authorized to manage your election network. Let's quickly cover what you need to know about them.

(transition)

[SHOW SIMPLE ADMINISTRATOR DIAGRAM]
An administrator is someone granted specific privileges or "scopes" to act on behalf of an authority. These scopes determine what actions they can perform, from creating ballot templates to approving registrations.

You should create multiple administrators for:
- Security through separation of duties
- Operational resilience if someone is unavailable
- Distribution of specialized responsibilities

(transition)

[SHOW SELECTION CRITERIA]
Choose administrators who:
- Are trusted members of your organization
- Understand election procedures
- Represent different departments or interests
- Have appropriate expertise for their assigned scopes

Be especially careful with the "UpdateAdministration" scope - administrators with this privilege can modify the administration itself.

(pause)

[SHOW KEY SCENARIOS]
Remove administrators when they:
- Leave relevant roles in your organization
- Have potentially compromised credentials
- No longer fit your administrative structure

(transition)

[SHOW NETWORK DIAGRAM]
If you create a new network, all administrator relationships are reset. Previous administrators have no automatic privileges in the new network - you must add them again explicitly.

Best practices include:
- Regular review of administrators and privileges
- Minimum necessary privilege allocation
- Clear succession procedures
- Documentation of roles and responsibilities
- Multi-administrator approval for critical actions

Proper administrator management is essential for election security and integrity. 