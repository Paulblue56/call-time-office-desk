# Call & Time

Static, browser-based call and attendance log website. Records stay in browser storage and can optionally sync to a private Supabase project.

## Publish with GitHub Pages

1. Upload the website files, including `.github/workflows/deploy.yml` and `.nojekyll`, to the `main` branch of the `Paulblue56/call-time-office-desk` repository.
2. In GitHub, open **Settings → Pages** and use **GitHub Actions** as the deployment source.
3. Wait for the **Deploy static website to GitHub Pages** workflow to finish.

The public website code does not contain customer data or Supabase secrets.

## Set up free private cloud sync

1. Create a Supabase Free project. Its free plan currently includes 500 MB of database storage; free projects pause after one week without activity.
2. In Supabase **SQL Editor**, run [`supabase-setup.sql`](./supabase-setup.sql). The table has row-level security so a signed-in user can only read or change their own workspace.
3. In **Authentication → Providers**, enable email/password sign-in and disable public sign-ups. In **Authentication → Users**, invite each authorized email; invitations are limited to people you choose.
4. On the HTTPS website, choose **Connect cloud storage** and sign in with the invited email and password. When first opening the invitation link, the website asks you to set a password. The project URL and public publishable key are already configured in the website. Never enter a `service_role` or secret key.
5. To bring in records from the original browser, open that browser's Call & Time page and select **Export backup**. On the hosted website, select **Merge backup** and choose the downloaded JSON. This merges records instead of replacing existing data; once signed in, the combined data syncs to Supabase.
6. On each other device, open the hosted website, choose **Connect cloud storage**, and sign in to the same Supabase account. Records sync on sign-in, after local changes, when a device reconnects or regains focus, and every 30 seconds while the site is open; browser storage remains a local copy.

The cloud integration uses Supabase Auth and its REST API directly; no server credential is embedded in the website. Cloud sync requires the SQL setup and account above. If the free project pauses, resume it in Supabase before syncing.

## Weekly reports

Weekly calls and weekly attendance have separate tabs. Both reports use Monday through Friday. Weekly calls includes incoming/outgoing totals by day, outcome and completion metrics, a busiest-day summary, and the week's call register. Completion rate counts successful call outcomes and failed attempts marked **Callback Completed**; the failed attempt remains a failed outcome and is not included in the succeeded-call count. When a later successful call matches an open callback by client and staff, the earlier call is saved as **Callback Completed** and is removed from the open follow-up queue; this applies across week boundaries. Weekly attendance shows the 40-hour target and staff variance and includes the daily attendance list for each workday. Present staff working remotely, going directly to a client, or working in the office and then going to a client count as 8 hours. Present office-only attendance uses recorded start/end times minus the one-hour lunch break for daily and weekly totals, target variance, and the landscape A3 PDF attendance report, which can span pages to keep rows readable. If office clock-in/out times are missing, only manually recorded hours are counted. Manager-approved leave, sick leave, and public holidays count as 8 hours; the weekly summary reports leave, sick leave, and public holidays separately from days physically present, with public holidays shown in both days and hours. The daily register and daily report show a dash for the work mode on leave, sick leave, and public holiday entries. For office-only shifts, 07:00–16:00, 08:00–17:00, or 09:00–18:00 therefore represents 8 work hours.

## Install Call & Time on desktop or phone

Call & Time is an installable Progressive Web App (PWA); it uses the same website, account, and Supabase cloud sync rather than separate native apps.

- **Windows / desktop:** Open the website in Microsoft Edge or Google Chrome and select **Install app** (or the install icon in the address bar/browser menu).
- **Android:** Open the website in Chrome, tap **Install app** or **Add to Home screen** when offered. The in-app **Install app** button also explains where to find the browser option.
- **iPhone / iPad:** Open the website in Safari, tap **Share**, then **Add to Home Screen**. Open it from the new Home Screen icon.

Open the website online once so the app shell is installed and cached. Afterwards, the interface and records saved on that device can still be used offline. Cloud sync and Microsoft 365 directory search need an internet connection. Each device/browser stores its own local copy; sign in to the same cloud account on every device to sync and share records. The offline cache contains the app files, not call or client records. Changes made offline sync when the connection is restored.
