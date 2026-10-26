# APW Hours Log

Hours logging for an advanced programming class. Python standard library only, so there's nothing to install.

```
python3 server.py
```

Then open http://localhost:8000. Use `PORT=9000` to pick a different port, and `APWLOG_DB=/path/to.db` to put the database somewhere else (it defaults to `apwlog.db`).

- **The first account created is the admin.** Everyone who signs up after that is a student.
- **Admins set the weeks.** In the admin panel's Weeks section, add each week with a start date, an end date and an optional label (e.g. "Week 5"). Weeks can be any length, but they can't overlap. Admins can edit or delete a week later; deleting a week also deletes the hours logged for it. If no week covers today, the app creates one for this Monday–Sunday automatically, so students always have somewhere to log hours. Admins can edit that week, or replace it with their own week if no one has logged hours in it yet.
- **Students log one total per week.** For every week that has started, a student enters their total hours and what they worked on. They can update or clear it any time. Weeks that haven't started yet are hidden.
- The admin panel shows a table of every student's hours for every week, with stats for the selected week. Admins can sort, export a CSV, click a student to read their weekly notes, promote students to admin, and reset passwords.

## Storing hours in a Google Sheet

Hours can be read from and written to a Google Sheet with the columns `Username, Name, Week, Hours, Notes`. There's one row per student per week, and `Week` is the week's start date. Accounts and week dates stay in the local database.

A "Publish to web" CSV link is read-only and cached, so it can't be used for this. The app talks to the sheet through a small Apps Script instead:

1. Open the spreadsheet (the editable one, not the published link) and go to **Extensions → Apps Script**.
2. Replace the editor's contents with [`apps_script.gs`](apps_script.gs). Change `TOKEN` to a long random string; `python3 -c "import secrets; print(secrets.token_urlsafe(24))"` makes one.
3. Click **Deploy → New deployment**, choose **Web app**, and set **Execute as: Me** and **Who has access: Anyone**. Authorize it when Google asks, then copy the web app URL (it ends in `/exec`).
4. Copy `config.example.json` to `config.json`, then fill in that URL and the same token.
5. Restart `python3 server.py`. It prints `Hours are stored in the Google Sheet`.

Notes:
- "Anyone" means anyone with the URL can reach the script, but it refuses every request that doesn't include your token. Keep `config.json` private; it's gitignored.
- You can type or edit rows directly in the sheet. The app picks them up within about 10 seconds. A row counts toward whichever week contains its `Week` date, and its `Username` must match an account in the app.
- If you edit the Apps Script later, use **Deploy → Manage deployments → Edit → New version** so the URL stays the same.
- Deleting a week in the app doesn't delete its rows from the sheet. They just stop appearing until a week covers their date again.
- Without `config.json`, hours are stored in the local database instead.
