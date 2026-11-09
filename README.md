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
