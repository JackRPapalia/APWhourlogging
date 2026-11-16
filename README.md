# APW Hours Log

Weekly hours logging for an advanced programming class, embedded in a Google Site. It runs entirely inside the school's Google Workspace: no separate server or hosting.

- **The app is an Apps Script web app** attached to the class spreadsheet. [`Code.gs`](Code.gs) reads and writes the sheet, and [`Index.html`](Index.html) is the page. The Google Site shows the page in an embed.
- **There's no separate login.** Google tells the script which @trevor.org account is signed in, so students just open the Google Site page.
- **Only people on the class list get in.** The list lives in the sheet's `Admins`, `Section 1` and `Section 2` tabs. Admins can add and remove people from the admin panel.

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
| `Admins`, `Section 1`, `Section 2` | email addresses in column A | The class list. A header row, blank rows and `mailto:` links are fine. Edit it here or from the admin panel. Before the first sign-in, type your own email into `Admins` by hand. Nobody is ever made an admin automatically, and if `Admins` is emptied, add an email here again to get back in. |
| `Users` | `Email, Name, Joined, Last login` | Created automatically. It records each person's name the first time they open the app, and when they last opened it. Names come from the school directory if the Admin SDK service is on (see Setup); otherwise the part of the email before the `@` is used. You can type a better name into the `Name` column at any time. |
| `Weeks` | `Id, Label, Start, End, Auto, No class` | Created automatically. Manage weeks from the admin panel. `No class` is `yes` for breaks. |
| `Settings` | `Key, Value` | Created automatically. `grace_days` is how many days after a week ends students can still change it (`none` for no deadline). |

You can type or edit hours rows directly in the sheet. A row counts toward whichever week contains its `Week` date. Deleting a week in the app doesn't delete its rows from the sheet; they just stop showing until a week covers their date again.

## Setup

The spreadsheet and its Apps Script must be **owned by a @trevor.org account**. Google only tells the script who's using it when the user and the script's owner are in the same Workspace domain.

### 1. Put the code in the spreadsheet's Apps Script project

1. Open the spreadsheet and go to **Extensions → Apps Script**.
2. Open `Code.gs` (rename the default file to that if needed). Replace everything in it with [`Code.gs`](Code.gs), then save.
3. Click **+** next to **Files**, choose **HTML**, and name it `Index` (Apps Script adds the `.html`). Replace everything in it with [`Index.html`](Index.html), then save.
4. If the project still has an old `apps_script.gs` file from the Firebase version, delete it.
5. Optional: to set the Google Site link used in reminder emails, put the Site page's address in `SITE_URL` at the top of `Code.gs`. If you leave it blank, emails link to the web app itself.

### 2. Optional: real names from the school directory

1. In the Apps Script editor, click **+** next to **Services**.
2. Choose **Admin SDK API**, keep the identifier `AdminDirectory`, then **Add**.

Without it, everything still works; new people are listed by their email name until you type a name into the `Users` tab. If your domain doesn't share directory names, IT may need to turn on **Directory → Sharing settings → Contact sharing** in the Admin console.

### 3. Deploy it as a web app

1. **Deploy → New deployment**, click the gear icon, choose **Web app**.
2. **Execute as: Me.** The script reads and writes the sheet as you, so students don't need access to the spreadsheet.
3. **Who has access: Anyone within trevor.org.** This keeps every other Google account out.
4. Click **Deploy**, approve the permissions it asks for, and copy the **Web app URL** (it ends in `/exec`).
5. Open that URL once yourself to check it loads. Your email must already be in the `Admins` tab.

After changing the code later: **Deploy → Manage deployments → pencil icon → Version: New version → Deploy.** The URL stays the same, so the Google Site doesn't need updating.

### 4. Add it to the Google Site

1. Open the Google Site in edit mode and go to the page where the hours log should live.
2. **Insert → Embed → By URL**, paste the web app URL, and choose **Whole page** if asked.
3. Drag the embed's handles to make it tall enough (the admin panel is long; full width and most of the page height works well).
4. **Publish** the Site, sharing it with people at trevor.org.

## Security notes

- Google decides who is signed in; the page can't claim to be someone else. Anyone outside trevor.org is blocked by the deployment's access setting, and anyone inside trevor.org who isn't on the class list gets a message telling them to ask their teacher.
- The page can only call two functions in `Code.gs`: `doGet` (which serves the page) and `api`. Every other function's name ends in `_`, which Apps Script keeps private. Keep it that way when adding code.
- Admin actions are checked in `Code.gs`, not just hidden in the page. Nobody is ever made an admin automatically.
- Text that would start a formula (`=`, `+`, `-`, `@`) is stored as plain text in the sheet and neutralized in CSV exports.
- Nothing is kept in the browser between visits, so a shared computer doesn't show the previous person's data.
