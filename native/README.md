# Pep Prep iPhone app

The same web app, wrapped with [Capacitor](https://capacitorjs.com) as a real iPhone app and installed with **TestFlight**.
No Mac is needed: GitHub builds it on Apple hardware (`.github/workflows/ios-testflight.yml`) every time `main` changes.

The app loads the live site (`server.url` in `capacitor.config.json`), so **web changes reach it within a minute**, the same
way they reach the home-screen version, and its service worker keeps it working offline. Only native changes (new plugins,
Swift code, permissions) need a new TestFlight build.

What the iPhone app adds over the home-screen shortcut (settings under Tools → App & backup):
- **Dose reminders** at each scheduled dose time, with **Log it** and **Snooze 15 min** buttons on the notification.
- **Weekly automatic backups** to iCloud Drive › Pep Prep (keeps the last 8), plus a Back up now button.
- **Apple Health**: weights you log are saved to Health; weigh-ins from a scale or another app are added as check-ins (never overwriting your own).
- **Calendar**: puts the next 8 weeks of doses in your calendar.
- **Barcode/QR scanning**: Scan in the Stash finds the vial with that code; the vial editor can store a vial's code.
- Haptics when you log a dose, its own storage that Safari can't clear, and share-sheet backups and labels.

## One-time setup

### 1. Apple Developer Program ($99/year)
Enrol at <https://developer.apple.com/programs/enroll/> with your Apple ID. Approval can take up to 48 hours.

### 2. Register the iCloud folder and the app's ID
<https://developer.apple.com/account/resources/identifiers/list> → **+** → **iCloud Containers** →
Description `Pep Prep`, Identifier `iCloud.com.kingc4rl.pepprep`. Continue → Register.

Then **+** again → **App IDs** → **App** → Description `Pep Prep`, Bundle ID **Explicit** `com.kingc4rl.pepprep`.
Under Capabilities tick **HealthKit** and **iCloud** (choose *Include CloudKit support* only if asked; then **Edit** next to iCloud
and select the `iCloud.com.kingc4rl.pepprep` container). Continue → Register.

### 3. Create the app in App Store Connect
<https://appstoreconnect.apple.com/apps> → **+** → **New App** → Platform iOS, Name `Pep Prep` (if taken, anything, e.g. `Pep Prep Personal`; it's never public),
language English, Bundle ID `com.kingc4rl.pepprep`, SKU `pepprep`, access **Full Access**. Create.

### 4. Make an App Store Connect API key
<https://appstoreconnect.apple.com/access/integrations/api> → **Team Keys** → **+** → name `GitHub`, access **Admin** → Generate.
Note the **Issuer ID** (top of the page) and the **Key ID**, then **Download** the `.p8` file (you can only download it once).
Your **Team ID** is at <https://developer.apple.com/account> → Membership details.

### 5. Add four secrets to GitHub
<https://github.com/kingc4rl/peptide-ledger/settings/secrets/actions> → **New repository secret**, four times:

| Name | Value |
|---|---|
| `APPLE_TEAM_ID` | Team ID, 10 characters |
| `ASC_KEY_ID` | Key ID |
| `ASC_ISSUER_ID` | Issuer ID (a long UUID) |
| `ASC_KEY_P8` | open the `.p8` file in a text editor and paste everything, including the BEGIN/END lines |

### 6. Build
<https://github.com/kingc4rl/peptide-ledger/actions/workflows/ios-testflight.yml> → **Run workflow**. It takes about 10–15 minutes,
then Apple processes the build for another 5–30 minutes.

### 7. Install on your iPhone
Install **TestFlight** from the App Store. In App Store Connect → your app → **TestFlight** → **Internal Testing** → **+** to create a group,
add yourself, and enable **automatic distribution**. Open the email/TestFlight invite on the phone and tap **Install**.
In TestFlight, turn on **Automatic Updates** for Pep Prep so new builds install themselves.

### 8. Move your data
In the home-screen app: Tools → Backup & restore → **Export backup file** → Save to Files.
In the new app: Tools → Backup & restore → **Restore** → pick that file. Once it looks right you can delete the old home-screen icon.

## Day to day
- Every push to `main` that changes the app starts a new build; TestFlight installs it automatically.
- TestFlight builds expire after 90 days, so if nothing changes for a while, re-run the workflow by hand.
- Web changes don't need a build at all: the app picks them up like the home-screen version ("A new version is ready" → Reload).
- The home-screen web version keeps working too, but its data is separate from the iPhone app's.

## Files
- `capacitor.config.json`: app ID and name.
- `copy-web.js`: writes `www/offline.html` (shown only if the very first launch has no connection) plus a reference copy of the web files.
- `ios/App/App/PepPrepNative.swift`: the app's own iCloud Drive backup plugin. `App.entitlements`: HealthKit and iCloud.
- `ios/`: the Xcode project (Swift Package Manager). `ios/App/App/Info.plist` holds the camera/photo permission texts.
- `assets/icon.png`: 1024 px app icon (no transparency, as Apple requires).
