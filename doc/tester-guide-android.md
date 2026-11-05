# VoteTorrent: Android Test Election Guide (for testers)

This guide takes a group of friends through a complete test election on Android phones: create the network, join it,
set up an election, register voters, vote, release the election keys, and see the decrypted results. Every form value
you need is listed.

Times are **Nepal time (NPT)**. Read the whole guide once before you start.

---

## 0. Status of this test build (read first)

| Step | Status in this build |
|---|---|
| Create network, invite, join | Works. Proven on phones over the internet relay. |
| Create ballot and election, keyholder setup (key generation) | Works in the app. Done by hand in the UI only partly before. |
| Voter registration | **Unproven on release APKs.** Registration has only ever passed with test builds. |
| Voting (sending votes in groups of 3) | Proven on phones with test builds. Needs **3 voters sending at the same time**. |
| Releasing election keys | Works in the app ("Release My Share"). |
| Decrypting votes and showing results | New in this build: a **Results** screen in both apps (section 11b). Proven on the computer; this is its first phone test. |

If something fails, write down the **exact message on screen**, the **time**, and the **step number** from this guide.
Then tell the organizer.

---

## 1. Roles and phones

You need **at least 6 Android phones**:

| Role | App | How many | What they do |
|---|---|---|---|
| **Officer (Founder)** | VoteTorrent Authority | 1 | Creates the network and election, invites everyone, approves voters. Use the **fastest phone** (not an old/budget phone). |
| **Keyholder A** | VoteTorrent Authority | 1 | Holds half of the election key. Generates the key; releases its share after voting. |
| **Keyholder B** | VoteTorrent Authority | 1 | Same as Keyholder A. |
| **Voter 1, 2, 3** | VoteTorrent Voter | 3 or more | Register and vote. **At least 3 voters are required.** Votes are sent in groups of 3. |

Rules:

- The Officer **cannot** also be a keyholder (the app refuses an invitation you sent yourself).
- Each phone should do **one role**. Do not install the Voter app on the Officer's phone.
- Each phone can be in **only one VoteTorrent network**. For a second test, uninstall and reinstall the app first.

---

## 2. Prepare every phone (all testers)

1. **Android settings**
   - Set a **screen lock** (PIN, pattern, or password).
   - **Voters:** enroll a **fingerprint**. Face unlock alone is usually not accepted.
   - Settings > System > Date & time: turn on **Set time automatically**. A wrong clock breaks voting.
   - Set **Screen timeout to 10 minutes** (or longer) for the test day.
   - Use good **Wi-Fi or mobile data**. If the app seems stuck, check your internet first.
   - Turn off **Battery saver** for the VoteTorrent app.
2. **Install the APK** the organizer sends you:
   - Officer and Keyholders: `VoteTorrent Authority` (about 130 MB).
   - Voters: `VoteTorrent Voter` (about 180 MB).
   - Open the file. If asked, allow **Install unknown apps** for your browser or file manager.
   - If Play Protect warns you, tap **More details > Install anyway**. These are test builds that are not on the Play Store.
3. Open the app once and allow any permission it asks for (camera, local network).

> **Most important rule:** keep the app **open on screen** whenever you are in a step. Many steps need two phones
> talking to each other. A phone with the app in the background or the screen locked cannot answer.

---

## 3. Plan the day (organizer)

Choose a start time **T**. T is when the Officer creates the election (step 6). Example: **T = 10:00 AM**.

| When | What | Who |
|---|---|---|
| T − 45 min | Officer creates the network (step 4) | Officer |
| T − 40 min | Everyone joins the network (step 5) | All |
| T | Officer creates the election (step 6), policy and ballot (step 7) | Officer |
| T + 10 min | Keyholder invitations and key generation (step 8) | Officer + Keyholders |
| T + 30 min to T + 2 h | Voter registration (step 9). **Must finish before T + 2 h.** | Voters + Officer |
| T + 2 h 30 min to T + 3 h 30 min | **Voting window** (step 10). All 3 voters vote together. | Voters |
| After T + 3 h 50 min | Keyholders release key shares, everyone sees the results (step 11) | Everyone |

Joining can take **up to 10–15 minutes** per phone. Start early.

---

## 4. Officer: create the network

App: **VoteTorrent Authority** on the Officer phone.

1. Open the app. The screen says "Choose a network to get started".
2. Tap the **cloud icon** (top left) to open **Networks**, then tap **Add Network**.
3. Fill in the form:

| Section | Field | Value to enter |
|---|---|---|
| Network | Name | `Friends Test Net 1` |
| Network | Image URL | *(leave empty)* |
| Election Characteristics | Keyholders | **Use keyholders** (default) |
| Election Characteristics | Authorities | **Single authority** (fixed) |
| Primary Authority | Name | `Friends Test Authority` |
| Primary Authority | Image URL | *(leave empty)* |
| Primary Authority | Domain Name | *(leave empty)* |
| Relays | Multiaddress | `/dns4/tunnel.inspiringlab.com.np/tcp/443/wss/p2p/12D3KooWBqKHipu5hGGcPt2Hk8noxN38ABAstFMPAvo4ASq3dCVe` |
| Initial Administrator | Name | your real name, e.g. `Arash Shrestha` |
| Initial Administrator | Title | `Election Officer` |
| Initial Administrator | **SIGN** | tap it so it is ticked |

   Copy and paste the relay address. Do not type it. It must be exactly one line with no spaces.

4. Tap **Create**.
   - **On a new install the first Create does not create the network.** It opens **Secure Signing Setup** instead.
     Tap **Set Up Secure Signing**, then **Continue**. You are back on the filled form. Tap **Create** again.
5. Wait. If it says "Still creating the network on this phone. Keep this screen open…", keep waiting.
6. A recovery-key screen appears. Tap **Set Up Secure Signing**, confirm with your fingerprint or PIN, then tap **Continue**.
7. You land on **Networks** with `Friends Test Net 1` listed. Go back. The home screen shows it as connected.

---

## 5. Everyone joins the network

### 5a. Officer: make the join code

1. Networks screen: tap the **person-plus icon ("Invite voters")** next to `Friends Test Net 1`.
   - If it asks "Manage who can join this network", tap **Continue**.
2. You see a **QR code**, a **fingerprint** (4 groups of 4 characters, e.g. `5522 5269 b1a4 af2f`), and "Valid until …".
3. Tap **Copy join code** or **Share join code** and send it to **all** testers (Keyholders and Voters) in the group chat.
   Also send a screenshot of the **fingerprint**.
   - The same code works for everyone. It is valid for 30 days.
4. **Keep the Authority app open on this screen (or any screen in the app) while people join.** If the Officer's app
   is in the background, joins fail with "did not accept this code".

### 5b. Keyholders A and B (Authority app)

1. Open the app > **cloud icon** > **Join a network**.
2. In **Join code**, tap **Paste** (or paste by long-pressing).
3. Check that the **Network fingerprint** shown is **exactly the same** as the Officer's screenshot.
4. Tap **Join network**. You will see "Joining the network…", then "Downloading the network…", then "Checking the
   network matches the code…". This can take **up to 10–15 minutes**. Keep the screen on.
5. When it opens **Secure Signing Setup**, tap **Set Up Secure Signing** > confirm > **Continue**.
6. When you see **"You joined Friends Test Net 1"**, tap **Done**.

### 5c. Voters 1, 2, 3 (Voter app)

1. Open the app > **Settings** tab > **Join a network**.
2. Either tap **Scan QR code** and point the camera at the Officer's QR code, or paste the code into **Join code**.
3. Check the **Network fingerprint** matches the Officer's.
4. Tap **Join network** and keep the screen on. It can take **up to 10–15 minutes** ("Downloading the network…").
5. When you see **"You joined Friends Test Net 1"**, tap **Done**.

If you see an error:

| Message | What to do |
|---|---|
| "…did not accept this code…" | Ask the Officer to open the Authority app, then tap Join again. |
| "…couldn't reach…" / "taking too long to download" | Check your internet, then try again. |
| Fingerprint does not match | **Stop.** Tell the organizer. Do not join. |
| "This phone founded its own network…" (Authority app) | This phone pressed Create before. Uninstall, reinstall, and join again. |

---

## 6. Officer: create the election (at time T)

App: **Authority**. Go to the **Elections** tab > **Create Election**.

Every date field opens a **date** dialog, then a **time** dialog. Tap **OK** on each. Do not tap outside the dialog,
because that also taps the screen behind it. **Fill in all ten timeline fields.** Leaving one blank can make the
election invisible to voters.

The values below use **T = 10:00 AM on 5 Nov** as an example. Shift every time by the same amount for your own T.

| Section | Field | Rule | Example (T = 5 Nov, 10:00 AM) |
|---|---|---|---|
| — | Election Type | Official | **Official** |
| Core | Title | any | `Friends Test Election 1` |
| Core | **Date** | **T + 11 days**, at 12:00 PM | **16 Nov, 12:00 PM** |
| Core | Revision Deadline | T + 1 day | **6 Nov, 10:00 AM** |
| Timeline | Registration Ends | T + 2 h | **5 Nov, 12:00 PM** |
| Timeline | Ballots Final | T + 2 h | **5 Nov, 12:00 PM** |
| Timeline | Voting Starts | T + 2 h 30 min | **5 Nov, 12:30 PM** |
| Timeline | Accruing Votes (voting ends) | T + 3 h 30 min | **5 Nov, 1:30 PM** |
| Timeline | Hashing Votes | T + 3 h 40 min | **5 Nov, 1:40 PM** |
| Timeline | Releasing Keys | T + 3 h 50 min | **5 Nov, 1:50 PM** |
| Timeline | Tallying Starts | T + 4 h | **5 Nov, 2:00 PM** |
| Timeline | Validation | T + 4 h 10 min | **5 Nov, 2:10 PM** |
| Timeline | Certification Starts | T + 4 h 20 min | **5 Nov, 2:20 PM** |
| Timeline | **Closed** | **Date + 1 h** (same day as Date) | **16 Nov, 1:00 PM** |
| Key holders | Key holder name (1) | | `Keyholder A` |
| Key holders | **Add Key Holder** > name (2) | | `Keyholder B` |
| Threshold Policy | | must read **2 of 2** | **2 of 2** |
| Tags | | | *(none)* |
| Instructions (optional) | | | `Test election - choose your favourite fruit.` |

Why the dates look odd:

- **Date must be at least 10 days away.** The app refuses an earlier date ("The election date is too soon").
- **Closed must be on or after Date.** Otherwise the Voter app cannot read the election.
- Registration Ends and Ballots Final must be **before** Voting Starts. The Officer's app does not check this, but the
  Voter app breaks if it is wrong.
- Voting Starts through Certification Starts must each be **later** than the one before.

Tap **Propose** and confirm with your fingerprint or PIN. The election appears in the Elections list.

**Use one election per network.** Voters are automatically shown the election whose Date is nearest. A second election
can confuse them.

---

## 7. Officer: registration settings and ballot

### 7a. Registration Policy

1. Elections > `Friends Test Election 1` > **Registration Policy**.
2. Under **Attestation**, tap **Don't Require Attestation** and save/confirm.
   This build cannot check Android phones with Google Play (these APKs are not on the Play Store), so the check must be off.
3. Leave **Fields** and **Disclosure** as they are.

### 7b. Turn on encrypted intake (before any voter registers)

1. **Authorities** tab > `Friends Test Authority` > **Registration Requests** > **Bulk Import / Sync**.
2. Tap **Enable Encrypted Intake** and confirm.
   Without this the Officer cannot read registration requests, and **Approve** stays disabled.

### 7c. Ballot

1. Elections > `Friends Test Election 1` > **Create Ballot Template**.
2. **Authority**: leave as `Friends Test Authority`. **Description**: `Fruit poll`. Leave **Districts / Groups** as is.
3. Tap **Add Question** and fill in:

| Field | Value |
|---|---|
| Code | `Q1` |
| Title | `What is your favourite fruit?` |
| Additional Instructions | `Choose one.` |
| Type | **Select** |
| Selection Limits | Min `1`, Max `1` |
| Force Order | off |
| Required | on |
| Group / Sequence | leave as is |

4. Tap **Add Option** three times (at least two options are required):

| Code | Title |
|---|---|
| `A` | `Apple` |
| `B` | `Banana` |
| `C` | `Mango` |

   Leave the other option fields empty and tap **Save** on each option, then **Save** on the question.
   Keep the Type as **Select**: the Results screen counts Select questions; Rank/Score/Text are not counted yet.
5. Tap **Propose**.
6. **This is not finished yet.** Open the ballot template again (status **Proposed**) and tap **Submit for confirmation**.
7. Go to the **Tasks** tab, open the new task, and tap **SIGN** (confirm with fingerprint/PIN).
   Voters cannot vote until this is signed.

---

## 8. Keyholders: accept invitations and generate the key

Must be finished **before Voting Starts**.

### 8a. Officer: invite each keyholder (do this twice: A, then B)

1. Elections > `Friends Test Election 1` > **Keyholders** section > **Invite**.
2. Under "Choose who to invite", pick `Keyholder A` (then `Keyholder B` the second time).
3. **Invitation valid for:** `24 hours`.
4. Tap **Send** and confirm.
5. Tap **Copy** or **Share** and send the invitation **privately** to that keyholder only.
   Do not leave the screen before you have copied or shared it.

### 8b. Each Keyholder: accept

1. Authority app > **person icon** (top right, Settings) > **Accept an Invitation**.
2. Paste the invitation into the box and tap **Continue**.
3. On **Keyholder Invitation**, tap **Accept** and confirm.
   - If it says "This invitation hasn't reached this device yet", wait one minute and try again.

### 8c. Both Keyholders: generate the key (at the same time)

1. Elections > `Friends Test Election 1` > **Keyholders** > tap **your own name**.
2. The status line says one of:
   - "Waiting for other keyholders to join"
   - "Generating key material…"
   - "Key generation complete"
3. There is **no button**. Each time you **open** this screen, the app does one step. So:
   **tap Back, wait about 15 seconds, and open your name again**. Repeat until it says **"Key generation complete"**.
   Both keyholders do this at the same time. Expect several fingerprint prompts.
4. Tell the group when both of you see **Key generation complete**.

Officer: after keyholders accept, **do not edit the election** ("Revise Election"). That would make them accept again.

---

## 9. Voter registration (before Registration Ends)

The voter and the Officer work **together**, both with their apps open. Do **one voter at a time**.

### 9a. Voter: fill in the form

Voter app > **Registration** tab > **Register now**.

1. "Verifying your device…" runs by itself.
   - If it says "This device can't be used to vote", that phone cannot take part. Tell the organizer.
2. **Step 1 of 3.** Use **different** details for each voter:

| Field | Voter 1 | Voter 2 | Voter 3 |
|---|---|---|---|
| First Name | `Asha` | `Bikash` | `Chandra` |
| Last Name | `Tester` | `Tester` | `Tester` |
| MM/DD/YYYY (date of birth) | `04/15/1990` | `08/22/1988` | `12/03/1995` |
| Email | `voter1@example.com` | `voter2@example.com` | `voter3@example.com` |
| Phone Number (10+ digits) | `9800000001` | `9800000002` | `9800000003` |

   Tap **Continue**.
3. **Step 2:**

| Field | Value |
|---|---|
| Address line 1 | `Ward 1, Kathmandu` |
| Address line 2 (optional) | *(empty)* |
| Address line 3 (optional) | *(empty)* |
| Select Your Party | **Independent** |

   Tap **Continue**. The next screen can take up to 30 seconds to appear. If nothing happens, tap Continue again.
4. **Step 3, Confirm:** check the details and tap **Submit**.
5. **"You're all set!"**: tap **Confirm with biometrics** and use your fingerprint.
6. The screen says "Waiting for the election office to approve your registration, so keep this screen open."
   **Keep it open** and tell the Officer you are waiting.

### 9b. Officer: approve the voter

1. **Authorities** tab > `Friends Test Authority` > **Registration Requests** > **Bulk Import / Sync**.
2. Tap **Try Peer Sync (Unverified)** and wait for it to finish (it can be slow the first time).
3. Go back to **Registration Requests** and open the new request.
4. Under **Out-of-Band Verification**, tick **Verified government-issued photo ID**.
5. Tap **Approve Registration** and confirm.
6. Go back to **Bulk Import / Sync** and tap **Try Peer Sync (Unverified)** again. Do it once more after a minute.
   This sends the approval to the voter and completes the device registration.

### 9c. Voter: finish

- After the Officer approves, your phone asks for your **fingerprint** again. Approve every prompt (about 4 in total).
- If you see "The election office hasn't answered yet, so tap Try Again after they approve…", tap **Try Again** after
  the Officer has synced.
- You may see "Your Registration Code" with **Copy Code**. Copy it and keep it.
- Done when you see **"Your device is registered. You can vote in this election."** Tap **Done**.

---

## 10. Voting (Voting Starts to Accruing Votes)

All 3 voters must do this **in the same 15 minutes**, with the app **open and the screen on**.

1. Voter app > **Vote** tab (Home). Before Voting Starts it says "Voting hasn't opened yet…".
   At Voting Starts a **Vote now** button appears. If it does not, switch to another tab and back.
2. Tap **Vote now** > **Continue Voting**.
3. Pick an answer (e.g. **Apple**, **Banana**, or **Mango**) > **Next Question**.
   **Write down what you chose** so the group can check the results later.
4. On **Review & Submit**, wait for "Checking whether you can vote…" to finish, then tap **Submit**.
   Approve **2 fingerprint prompts** ("Confirm your vote", "Save your vote").
5. The receipt opens and asks for a fingerprint once more ("Show your saved vote"). Your vote is saved **on this phone only**.
6. On the **Vote saved** screen, in the "Send your vote" card, tap **Send my vote**.
   - Approve "Open your saved vote".
   - You see "Waiting for other voters (1 so far, 3 needed)…". **Stay on this screen with the screen on.**
   - When 3 voters are ready: "Joined a group of voters…", then "Confirm with your fingerprint to send." **Approve it
     within 2 minutes.**
7. Done when you see **"Your vote has been sent to the election."** This took about 3 minutes in tests.

Rules for voting:

- **Do not leave the app or lock the phone while sending.** A phone in the background leaves its group and the others
  have to wait for a new one.
- If one person misses the fingerprint prompt, the group waits about 2 minutes and then tries again.
- If fewer than 3 voters send before voting ends, nobody's vote is sent ("Not sent: voting closed before enough voters
  were ready…").
- Do **not** clear app data or uninstall after voting. The saved vote lives only on your phone.

---

## 11. Releasing keys, decrypting, and the results

### 11a. Keyholders: release your share (after Releasing Keys)

1. Authority app > **Tasks** tab. A card with a **Release** chip appears once the Releasing Keys time has passed.
2. Open it. On **Release Your Key Share**, tap **Release My Share**. Approve 2 fingerprint prompts.
3. Done when it says **"Your share has been released"**.

Voters can follow along: **Timeline** tab > **View Keyholders** shows "2 of 2 keys released".

### 11b. Decrypting the votes and seeing the results

Once **both** keyholders have released their shares, any phone can decrypt and count the votes. Nobody presses a
"decrypt" button: the **Results** screen rebuilds the election key from the two released shares, decrypts every vote
block published to the network, checks each vote, and counts them, all on your own phone.

**Officer and Keyholders (Authority app):**

1. Elections > `Friends Test Election 1` > **Results**.
2. Before both shares are released it says **"Results are locked"** and "Key shares released: 1 of 2 needed".
   Tap **Refresh** after the second keyholder releases.
3. After release it shows:
   - "Valid votes: 3" and "Vote blocks: 1"
   - each answer with its count and percentage, e.g. `Apple 2 (67%)`, `Banana 1 (33%)`, `Mango 0 (0%)`
   - "Invalid votes" or "Votes in rejected blocks" only if some votes failed the checks
   - a short **Tally root** code at the bottom. Every phone should show the **same** code; compare them in the group chat.

**Voters (Voter app):**

1. **Timeline** tab > on the **Tallying** row, tap **View results** (it appears once Tallying Starts has passed).
2. Same as above: locked until both shares are released, then the counts. Tap **Refresh** to count again.

Check that the counts match the choices the group wrote down in step 10. Every phone should show the same numbers.

---

## 12. Troubleshooting

| Problem | Try this |
|---|---|
| Stuck on "Downloading the network…" for over 15 min | Check internet. Make sure the Officer's app is open. Close and reopen the app, then try again. |
| "Not configured" banner | The APK was built without the relay. Ask the organizer for a new APK. |
| Voter sees "No election is available on this network yet." | The Officer has not created the election, the election dates are wrong, or the phone has not synced yet. Wait a few minutes. |
| "Set up fingerprint or face unlock to continue" | Enroll a fingerprint in Android settings. |
| Officer's **Approve Registration** is greyed out | Step 7b (Enable Encrypted Intake) was missed. |
| "The election isn't ready to receive votes yet." | Key generation (step 8c) is not finished. |
| Vote now never appears | Switch tabs. Check the phone's clock is automatic. Check Voting Starts has passed. |
| Results still "locked" after both keyholders released | Wait a minute for the releases to sync to your phone, then tap **Refresh**. |
| Results say "could not be computed" with a Reason | Screenshot it (the Reason code matters) and send it to the organizer. |
| Results say "No vote blocks have reached this device yet" | The votes have not synced to your phone yet. Wait a minute, then tap **Refresh**. In tests this took about 5 seconds. |
| Results counts differ between phones | A phone may not have synced every vote block yet. Wait, tap **Refresh** on both, and compare the "Vote blocks" number and the Tally root again. |
| Anything else | Screenshot the screen, note the time and step number, and send it to the organizer. |

**Starting a fresh test:** every phone must **uninstall and reinstall** its app (or Settings > Apps > VoteTorrent >
Storage > **Clear storage**). Then go back to step 4.
