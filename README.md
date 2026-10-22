# Email Studio

A small, password-protected tool for building and storing HTML emails.

- **Edit**: HTML on the left, live preview (desktop / phone) on the right
- **Templates**: save, rename, duplicate, delete, search, and organize with tags
- **Images**: upload once, get a permanent link (stored in Cloudflare R2)
- **Copy / paste**: one-click "Copy HTML" and "Paste HTML" for the church email tool
- **Checks**: warns about Gmail's ~100 KB clipping, non-https image links, missing alt text

It runs on Cloudflare Pages (free tier). This repository **is** the website:
whatever is on the `main` branch here is what goes live, automatically,
about a minute after each change.

---

## How to update the site (no terminal needed)

### Change one file
1. In this repository on github.com, click through to the file (for example
   `public/index.html`).
2. Click the **pencil icon** (Edit this file) at the top right of the file.
3. Make your change.
4. Click **Commit changes...**, then **Commit changes** again in the box.

### Replace or add several files at once
1. On the repository's main page, click **Add file**, then **Upload files**.
2. Drag in the folders or files. Drag whole folders (like `functions` or
   `public`) so everything lands in the right place. A file with the same path
   as an existing one replaces it.
3. Scroll down and click **Commit changes**.

### Check that it went live
In the Cloudflare dashboard go to **Workers & Pages**, click this project, then
**Deployments**. The top entry should say **Production** and **Success**
within a minute or two. If it says **Failed**, click it to read the log and
send that message to whoever maintains this.

To undo a bad change, open the **Deployments** tab, find an older **Success**
entry, click the three dots, and choose **Rollback to this deployment**.

---

## What is in this repository

```
public/index.html          the whole interface (no build step)
functions/_middleware.js   locks /api/* behind the login
functions/_lib/auth.js     password check + signed session cookie
functions/_lib/tags.js     rules for template tags
functions/api/*            login, templates (KV), images (R2)
functions/img/[key].js     public image links used inside emails
wrangler.toml              project settings and storage connections
```

`wrangler.toml` is the source of truth for the storage connections (KV for
templates, R2 for images). Those can't be edited in the Cloudflare dashboard,
only here.

**The password is never in this repository.** It is a Cloudflare secret named
`APP_PASSWORD` (see below). Never paste it into any file here.

---

## First-time setup (already done if the site is running)

1. **Storage.** In the Cloudflare dashboard: *Storage & Databases* then
   *KV* to create a namespace named `TEMPLATES` and copy its **ID** into
   `wrangler.toml`; *R2 Object Storage* to create a bucket named
   `email-images`. (R2 may ask for a payment card to enable it; the free
   allowance is large.)
2. **Connect this repository.** Workers & Pages, *Create application*,
   *Pages*, *Connect to Git*, pick this repository. Settings: framework
   preset **None**, build command **empty**, build output directory
   **`public`**.
3. **Set the password.** Project, *Settings*, *Variables and Secrets*,
   *Add*, type **Secret**, name `APP_PASSWORD`, then enter the password.
   Save it in your password manager too; Cloudflare won't show it again.
4. **Redeploy** (Deployments tab, three dots on the top entry, *Retry
   deployment*) so the password takes effect. Secrets only apply to
   deployments made after they are set.
5. **Custom address (recommended).** Project, *Custom domains*, add something
   like `email.yourchurch.org`, then in `wrangler.toml` uncomment `[vars]` and
   set `PUBLIC_BASE_URL = "https://email.yourchurch.org"`.
   Image links in sent emails are tied to the address the image was uploaded
   from, so set this up **before** uploading real images and never change it.

**To change the password:** edit the `APP_PASSWORD` secret in the dashboard,
then retry the latest deployment. Everyone is logged out automatically.

---

## Security notes

- The password is a Cloudflare secret, compared in constant time; sessions are
  signed cookies (HttpOnly, SameSite=Strict, 30 days).
- Only `/img/*` links are public, because email apps must load them. Anyone
  with an image link can view that image, but nobody can list, upload or
  delete without the password.
- Uploads are checked by their real file contents (PNG/JPG/GIF/WebP only).
  SVG is intentionally not allowed because most email apps don't show it.
- Keep this repository **private**.

## Backups

Templates are just text: use **Copy HTML** on anything important and keep a
copy in Google Drive. Images can be exported from the R2 bucket in the
Cloudflare dashboard.

---

## Optional: running it on your own computer

Only for people comfortable with a terminal. Needs Node.js.

```bash
npm install
cp .dev.vars.example .dev.vars    # throwaway local password
npm run dev
```

Local mode uses temporary fake storage, so it never touches real data.
