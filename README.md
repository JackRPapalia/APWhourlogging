# APW Hours Log

Weekly hours logging for an advanced programming class, hosted on GitHub Pages.

- **Login** uses Firebase Authentication: email and password, or Google. Students can reset their own passwords.
- **Data** lives in a Google Sheet. A Google Apps Script ([`apps_script.gs`](apps_script.gs)) is the backend. It checks every request's Firebase login with Google before it reads or writes anything.
- **The first person to sign in becomes the admin.** Everyone after that is a student. Admins can make other people admins.

## How it works

- **Admins set the weeks.** Each week has a start date, an end date and an optional label (e.g. "Week 5"). Weeks can be any length, but they can't overlap. If no week covers today, one is created automatically for this Monday–Sunday, so students always have somewhere to log hours. Admins can edit that week, or replace it with their own week if no one has logged hours in it yet.
- **Students log one total per week.** For every week that has started, a student enters their total hours and what they worked on. They can update or clear it any time.
- **The admin panel** shows every student's hours for every week, with stats for the selected week. Admins can sort, export a CSV, click a student to read their weekly notes, and change roles.

## The spreadsheet

| Tab | Columns | Notes |
| --- | --- | --- |
| first tab | `Username, Name, Week, Hours, Notes` | One row per student per week. `Username` is the student's email, and `Week` is the week's start date. |
| `Users` | `Email, Name, Role, Joined` | Created automatically. Set `Role` to `admin` or `student`. |
| `Weeks` | `Id, Label, Start, End, Auto` | Created automatically. Manage weeks from the admin panel. |

You can type or edit hours rows directly in the sheet. A row counts toward whichever week contains its `Week` date. Deleting a week in the app doesn't delete its rows from the sheet; they just stop showing until a week covers their date again.

## Setup

### 1. Firebase

1. In the [Firebase console](https://console.firebase.google.com/), create a project, or use an existing one.
2. **Build → Authentication → Get started.** Under **Sign-in method**, enable **Email/Password** and **Google**.
3. **Authentication → Settings → Authorized domains:** add `jackrpapalia.github.io`. `localhost` is already there.
4. **Project settings (gear icon) → General → Your apps:** add a **Web app** (`</>`). Copy the `firebaseConfig` values into [`config.js`](config.js).

### 2. Apps Script

1. Open the spreadsheet and go to **Extensions → Apps Script**. Replace the code with [`apps_script.gs`](apps_script.gs).
2. Set `FIREBASE_API_KEY` at the top to the same `apiKey` as in `config.js`, then save.
3. **Deploy → Manage deployments → pencil icon → Version: New version → Deploy.** If this is the first deployment, use **New deployment → Web app** instead, with **Execute as: Me** and **Who has access: Anyone**.
4. Put the web app URL (it ends in `/exec`) in `SCRIPT_URL` in `config.js`.

### 3. GitHub Pages

In the GitHub repo, go to **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, then **main** and **/ (root)**. The site is published at `https://jackrpapalia.github.io/APWhourlogging/`.

## Run it locally

```
python3 -m http.server 8000
```

Then open http://localhost:8000. Opening `index.html` straight from Finder won't work, because browsers block modules on `file://` pages.

## Security notes

- `config.js` is public on purpose: Firebase web config isn't a secret, and neither is the script URL. What protects the data is the Apps Script, which checks each request's Firebase ID token with Google and allows admin actions only for users whose role is `admin`.
- Anyone can create an account. That's how students join, but it means a stranger who finds the site could sign up as a "student." Admins can see everyone in the overview. If you want to limit sign-ups to school emails, that's a small change in `registerUser_`.
