# APW Hours Log

Weekly hours logging for an advanced programming class, hosted on GitHub Pages.

- **Login** uses Firebase Authentication with Google sign-in only. The account picker suggests @trevor.org accounts first, and there's a link for people on other domains. There are no passwords to manage.
- **Data** lives in a Google Sheet. A Google Apps Script ([`apps_script.gs`](apps_script.gs)) is the backend. It checks every request's Firebase login with Google before it reads or writes anything.
- **Only people on the class list can sign in.** The list lives in the sheet's `Admins`, `Section 1` and `Section 2` tabs. Admins can add and remove people from the admin panel.

## How it works

- **Admins set the weeks**, one at a time or with **Set up several weeks at once**: pick the first day, how many weeks and how long each is, tick the breaks, and create them all. Each week has a start date, an end date, an optional label (e.g. "Week 5"), and can be marked **No class**. No-class weeks don't ask students for hours and don't count as missing. Weeks can be any length, but they can't overlap. If no week covers today, one is created automatically for this Monday–Sunday, so students always have somewhere to log hours. Admins can edit that week, or replace it with their own week if no one has logged hours in it yet.
- **Students log one total per week.** For every week that has started, a student enters their total hours and what they worked on, and sees a chart of their hours per week.
- **Deadlines.** Students can change a week until a set number of days after it ends (2 by default; change it in the admin panel's Weeks section, or turn it off). After that the week is closed to them. Admins can still change any week. Entries saved after the week ended are marked *late*.
- **The admin panel** shows every student's hours for every week, with stats for the selected week. Admins can filter by section, sort, export a CSV, and see a chart of class hours per week. Under the chart is a list of students who haven't logged the selected week, with buttons to email them (BCC) or copy their addresses. Clicking a student shows their weekly notes, when each was last updated and by whom, and lets an admin correct or clear any week, or **excuse** the student from a week (with an optional reason). Excused weeks don't count as missing; if the student logs hours anyway, the hours replace the excuse.
- **The class list** (in the admin panel) adds emails to Section 1, Section 2 or Admin, one at a time or by pasting a whole list. A student can only be in one section, so adding them to a section moves them out of the other. Removing someone from every list stops them signing in, but their logged hours stay in the sheet.

## The spreadsheet

| Tab | Columns | Notes |
| --- | --- | --- |
| first tab | `Username, Name, Week, Hours, Notes, Updated, Updated by, Excused` | One row per student per week. `Username` is the student's email, and `Week` is the week's start date. `Updated` and `Updated by` are filled in on every save. An excused week has `Excused` = `yes`, no hours, and the reason in `Notes`. Missing columns are added automatically. |
| `Admins`, `Section 1`, `Section 2` | email addresses in column A | The class list. A header row, blank rows and `mailto:` links are fine. Edit it here or from the admin panel. If `Admins` is ever empty, the next person to sign in is added to it, so you can't lock yourself out. |
| `Users` | `Email, Name, Joined, Last login` | Created automatically. It records each person's name from Google the first time they sign in, and when they last opened the site. |
| `Weeks` | `Id, Label, Start, End, Auto, No class` | Created automatically. Manage weeks from the admin panel. `No class` is `yes` for breaks. |
| `Settings` | `Key, Value` | Created automatically. `grace_days` is how many days after a week ends students can still change it (`none` for no deadline). |

You can type or edit hours rows directly in the sheet. A row counts toward whichever week contains its `Week` date. Deleting a week in the app doesn't delete its rows from the sheet; they just stop showing until a week covers their date again.

## Setup

### 1. Firebase

1. In the [Firebase console](https://console.firebase.google.com/), create a project, or use an existing one.
2. **Build → Authentication → Get started.** Under **Sign-in method**, enable **Google**. Leave **Email/Password** off.
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
- Only emails on the class list can sign in. Anyone else gets a message telling them to ask their teacher.
