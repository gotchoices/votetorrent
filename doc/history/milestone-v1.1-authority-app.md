# What Changed in v1.1 — Authority App

*A plain-language summary of the v1.1 milestone (late May – June 1, 2026).*

## The goal

Make the **Authority App** look and behave the way it does in the Figma designs — every screen — and build the screens that were designed but didn't exist yet. By the end of v1.1, an authority can walk through the whole app and every screen is in place, properly laid out, available in **English and Spanish**, and reachable through normal navigation.

Everything in this milestone runs on **sample (mock) data** on purpose. The real backend (the voting engine) is being built separately, so the app was wired to stand-in data to keep this work independent. That means buttons like "Propose" or "Save" currently navigate and log rather than actually persisting — real data wiring comes later.

## At a glance

- The whole Authority App is now in **visual parity with Figma**.
- **Both English and Spanish** are supported everywhere, with an in-app language switch that remembers your choice.
- Several **brand-new screens** were built from scratch.
- The app was reviewed against the designs, gaps were found and fixed, and a final hands-on pass tightened up the Authority flow.

---

## What's new

Screens that didn't exist before and were built during this milestone:

- **Create Election** — start a new election from the elections list and fill out its details in one place.
- **Create Ballot** — build a ballot from an election, including adding questions and the answer options inside each question.
- **Edit Election / Revision** — propose changes to an existing election.
- **Add Key / Add Device confirmations** — the "here's your new key/device" success screens.
- **Keyholder invitation** — send and accept invitations for keyholders.
- **Onboarding / "waiting" screens** — the in-between states shown while invitations are pending.

## What got better

Existing screens were reworked to match the designs and feel consistent:

- **Tasks** — the task list now groups items by authority, shows an empty state, and labels each task by type. The signature-approval screens (for administrators, authorities, networks, elections, and ballots) were rebuilt on a shared layout so they all look and behave the same.
- **Authorities** — the list, the authority detail, and the administration sections (current and proposed) were brought to parity, including the administrator and invitation screens.
- **Networks** — the network list, network detail, "new network," and "connect to a network" screens were polished, along with the network revision flow.
- **Elections & Ballots** — the elections list, election detail (timeline, keyholders, tags, deadlines), and the ballot template / question / option screens were all reworked to match the designs.
- **Users, Keys & Devices** — user detail, default user, revise user, add/revoke key, keys list, and add device screens were updated.
- **Keyholder & Settings** — the keyholder detail screen and the settings screen (language, default user, theme) were brought into line.
- **Shared building blocks** — the common buttons, chips, cards, headers, and footers were aligned so they look the same everywhere, and the footer was fixed app-wide so it no longer collides with the Android navigation bar.

## A final pass on the Authority flow

After the milestone was reviewed and signed off, a careful screen-by-screen recheck of the **Authority flow** against the live designs caught a handful of smaller things the review had missed, and they were fixed:

- The **Edit Administrator** screen was cleaned up, and a duplicate, older "replace admin" screen was removed in favor of the canonical one.
- The administrator's **invitation entry now shows as a proper card** instead of blending into the background.
- The **proposed-administration** view was reworked to match the design (cleaner administrator entries, status text, and a single, consistent way to adjust the proposal).
- An **"Invite Authority" button that was running off the edge** of the screen was fixed.
- Two **cards that did nothing when tapped** now go where they should — one opens the user's profile, the other opens the administrator editor.
- The administrator editor now correctly shows a **different layout when editing an existing person** versus adding a new one.

As part of this, all of the Authority App's design frames were rendered and mapped to make sure nothing was missed. The other areas (Elections, Ballots, Users, Keyholder, Networks) weren't re-checked frame-by-frame in this last pass — if any small design mismatches turn up there, they'll be handled as follow-ups.

## Behind the scenes

- **Spanish throughout** — every visible piece of text was given both an English and Spanish version, with an automated check that keeps the two in sync, plus a language toggle in Settings that's remembered between launches.
- **Consistent styling** — screens use the app's theme colors rather than one-off values, so light/dark and future theming stay consistent.
- **Everything reachable** — each new screen is properly registered in the app's navigation so it can be opened the normal way.

## What's intentionally not done yet

These were deliberately left for later milestones:

- **Real data** — the app still runs on sample data; connecting it to the real voting engine and saving data permanently comes once that engine is ready.
- **Actually submitting forms** — "Propose," "Save," and similar actions currently move you along but don't persist; full form submission and validation come with the real backend.
- **Networking between devices** (peer-to-peer) and the separate **voter app** are out of scope for this milestone.

---

*This milestone is complete and reviewed, and is ready to be formally closed.*
