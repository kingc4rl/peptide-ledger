# Pep Prep iPhone app

The same web app, wrapped with [Capacitor](https://capacitorjs.com) as a real iPhone app and installed with **TestFlight**.
No Mac is needed: GitHub builds it on Apple hardware (`.github/workflows/ios-testflight.yml`) every time `main` changes.

What the iPhone app adds over the home-screen shortcut:
- **Dose reminders**: a notification at each scheduled dose time (next 14 days, refreshed every time the app opens or a dose is logged). Toggle under Tools → App & backup.
- Its own storage, which Safari can never clear and which is included in iPhone backups.
- Backups and labels go out through the share sheet (Save to Files, AirDrop, Print).

## One-time setup

### 1. Apple Developer Program ($99/year)
Enrol at <https://developer.apple.com/programs/enroll/> with your Apple ID. Approval can take up to 48 hours.

### 2. Register the app's ID
<https://developer.apple.com/account/resources/identifiers/list> → **+** → **App IDs** → **App** →
Description `Pep Prep`, Bundle ID **Explicit** `com.kingc4rl.pepprep`. Continue → Register.

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
- The home-screen web version keeps working too, but its data is separate from the iPhone app's.

## Files
- `capacitor.config.json`: app ID and name.
- `copy-web.js`: copies `index.html`, `app.js`, `manifest.webmanifest` and `icons/` into `www/` (the build copies them into the app).
- `ios/`: the Xcode project (Swift Package Manager). `ios/App/App/Info.plist` holds the camera/photo permission texts.
- `assets/icon.png`: 1024 px app icon (no transparency, as Apple requires).
