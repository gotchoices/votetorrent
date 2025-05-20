# VoteTorrent Admin Tutorial: Understanding the "Create Network" Button

## Tutorial Goals & Objectives

This tutorial aims to:
- Explain the significance of the "Create Network" button in the admin mobile UI
- Clarify when administrators should and should not create a new network
- Detail the consequences of losing the private key used to create a network
- Provide best practices for network management
- Help non-technical administrators make informed decisions about network creation

The tutorial targets election administrators who may not possess technical knowledge about cryptography or distributed systems, but need to understand this critical function for proper election management.

---

## Video Narration Script (Full Version - ~500 words)

[SHOW CREATE NETWORK BUTTON ON INTERFACE]

This button carries significant power. When you press it, you're establishing the foundation for your entire election system. Let's explore what this means and when you should - and shouldn't - use this function.

(transition)

[SHOW DIAGRAM OF NETWORK] 
An Election Network is a secure digital vault where all your election records are stored and verified. Unlike traditional systems with central servers, VoteTorrent distributes information across multiple devices for better security and transparency.

When you create a network, you become the "primary authority" - essentially the root of trust for the entire system. This comes with significant responsibility, so understanding when to create a new network is critical.

(transition)

Let's examine when you SHOULD create a new network: [SHOW CHECKLIST]

First, when you're starting fresh. This includes setting up your very first election with VoteTorrent, beginning a completely separate election cycle with different voters, or creating a distinct voting organization - like moving from school board to city council elections.

Second, after any security compromise. If you suspect the previous network's primary key was exposed, or there's evidence of tampering, it's time for a fresh start with a new network.

Third, after an administrative expiration. This happens when the previous authority's administration period has expired beyond renewal, or you can no longer access the administrator account that created the original network.

(pause)

Equally important is understanding when NOT to create a new network: [SHOW "DO NOT" LIST]

Don't create a new network for routine elections within the same organization, or new election cycles with the same voter base. Also, don't create a new network just because you're adding administrators, changing election parameters, or updating ballot templates. These operations can all be performed within your existing network.

(transition)

The private key used to create your network is critically important. [SHOW KEY ICON] Here's why:

The network's very identity is linked to this key. All delegated authorities trace back to it. And only the primary authority can recover from administrative lapses.

If you lose this key, you won't be able to authorize new administrators if authority chains break, you can't make critical changes to the primary authority, and you may eventually need to start from scratch with a new network.

(pause)

Here are essential best practices: [SHOW BEST PRACTICES LIST]

Always secure your key with biometric protection and keep secure backups. Plan for administrator succession by having multiple administrators with appropriate permissions. Renew your administration before expiration dates. Document when and why you created each network. And finally, practice in a test environment before creating production networks.

Creating a network establishes you as the primary authority - a powerful position with long-term responsibilities. Only create a new network when truly necessary, and always protect the private key used to establish it.

---

## Video Narration Script (Concise Version - ~250 words)

[SHOW CREATE NETWORK BUTTON]

When you press this button, you're establishing an entire election system and becoming its primary authority. Let's quickly cover when you should - and shouldn't - use this important function.

(transition)

[SHOW SIMPLE NETWORK VISUALIZATION]
An Election Network is a distributed database that securely stores all your election records across multiple devices. 

You should create a new network when: [SHOW LIST WITH ICONS]
- You're setting up your first VoteTorrent election
- You're creating a separate voting organization (like moving from county to state elections)
- After a security breach compromises the primary administrator's key
- When a previous authority's administration has expired beyond recovery

(transition)

However, don't create a new network for: [SHOW "NO" SYMBOLS]
- Regular elections within your organization
- New election cycles with the same voters
- Simple changes to administrators, ballots, or parameters

(pause)

Your network's private key is crucial - if lost: [SHOW KEY ICON]
- You can't authorize new administrators if authority chains break
- You may eventually need to start over completely

(transition)

Best practices include: [SHOW QUICK CHECKLIST]
- Securing your key with biometrics and backups
- Having multiple administrators
- Renewing your administration before expiration
- Testing in a sandbox environment first

Creating a network is a significant decision with long-term consequences. Use this power wisely, and always safeguard that private key. 