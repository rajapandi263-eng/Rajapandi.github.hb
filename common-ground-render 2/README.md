# Common Ground for Render

This is the shared server version of Common Ground. Colleagues connect to the same website, create separate accounts, find each other's profiles, give Power bumps and exchange private text messages from different devices. The server stores this pilot's accounts and messages in SQLite on a Render persistent disk.

## Get the repository URL Render needs

The app website address is different from its Git repository address. No remote repository is created by this download.

1. Create a repository named `common-ground` in your GitHub, GitLab or Bitbucket account. A private repository works with Render's **Git Provider** connection.
2. Upload the **contents** of this folder to that repository. `package.json`, `server.mjs`, `render.yaml` and `public/` must be at the repository root. Upload extracted files, not the ZIP itself. Include `.node-version` and `.gitignore`.
3. Copy the repository's web address. It has the form `https://github.com/YOUR-ACCOUNT/common-ground` (an example format, not an existing repository).
4. In Render, choose **Git Provider**, connect that account and select your repository. Render's separate **Public Git Repository** field accepts a public repository address; a private repository requires the connected provider.

## Deploy using the included Blueprint

In Render, choose **New → Blueprint**, select your repository and review `render.yaml`. It provisions a paid Node web service with a 1 GB persistent disk. Review the current charges before confirming deployment. It does not create a separate Postgres database.

The Blueprint starts one instance, disables automatic deploys, and generates a random `REGISTRATION_CODE`. Render provides the HTTPS site address through `RENDER_EXTERNAL_URL`; the server uses that exact address for its origin checks. After a source update, deploy manually from Render. Do not run multiple instances against this SQLite file.

## If you are already on New → Web Service

Select the repository and use:

| Field | Value |
|---|---|
| Language | Node |
| Node version | Defined in `.node-version` |
| Build command | `npm ci --omit=dev` |
| Start command | `npm start` |
| Health check | `/healthz` |
| Instance | Paid compute, one instance |
| Disk | 1 GB, mounted at `/var/data` |

Add these environment variables before deploying:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DEPLOYMENT_MODE` | `hosted` |
| `HOST` | `0.0.0.0` |
| `DB_PATH` | `/var/data/network.sqlite` |
| `DEMO_MODE` | `false` |
| `REGISTRATION_ENABLED` | `true` |
| `REGISTRATION_CODE` | A random secret of 24–128 characters, entered only in Render |

Leave `PORT` to Render. Do not set a placeholder `APP_ORIGIN`; the server uses Render's own HTTPS address by default. If you later add a custom domain, set `APP_ORIGIN` to that exact HTTPS origin, without a trailing slash, and give everyone that same address.

## Invite your colleague

1. Once Render reports a successful deployment, open its HTTPS app link.
2. Find the generated `REGISTRATION_CODE` in the service's Environment settings. Share that pilot join code privately with your colleague, along with the app link. Do not put it in Git, a screenshot or a public message.
3. Each person chooses **Create account**, enters their own email, a password of at least 12 characters and the pilot join code, then finishes their profile.
4. Both people now appear in the same directory and can use **Send message** to chat. Power bumps remain personal bookmarks.

To stop additional sign-ups, set `REGISTRATION_ENABLED=false` and restart/deploy the service. Existing accounts continue working. Rotating `REGISTRATION_CODE` changes the code needed for future sign-ups, not existing passwords.

Company SSO and email ownership verification are not included. The join code limits participation to people who receive it; it does not verify their employee identity. There is no email password-reset flow in this pilot. Messages are visible in the app only to their two participants; the hosting/database operator can access stored data.

## Mobile installation and connectivity

The shared site is designed for phones, tablets and desktops. Open it in Safari or Chrome and use the app's installation help to add it to the home screen. Accounts, directory changes and chat need an internet connection. Only public app files are cached; messages and account API responses are not stored in the service worker cache. Actual home-screen installation still needs checking on your intended iPhone/iPad and Android hardware.

## Local development

Use Node.js 24.12 or newer within the 24.x series:

```sh
npm ci
npm test
npm start
```

Defaults run a local pilot at `http://127.0.0.1:4310`. Copy `.env.example` to `.env` to set local options. The local database is created on first start and is ignored by Git. Never upload an existing local pilot database or real environment file to a repository.

This package starts with an empty shared database when first deployed. It does not import accounts or messages from the separate Mac or mobile device pilots. Keep the same Render service, hostname and attached disk for subsequent updates. A disk prevents restart-related data loss; it is not a replacement for a verified SQLite backup and restore procedure.

## References

- [Render web services](https://render.com/docs/web-services)
- [Render persistent disks](https://render.com/docs/disks)
- [Render Blueprint configuration](https://render.com/docs/blueprint-spec)
- [Render-provided environment variables](https://render.com/docs/environment-variables)
