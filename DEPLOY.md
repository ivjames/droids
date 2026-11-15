# Deploying Droid Talk

Target: **https://droids.lab980.com** — served from the lab980 droplet
(conventions in the `ivjames/lab980.com` repo's `CLAUDE.md`).

Shape: nginx proxies to a pm2-managed gunicorn (Python / Flask) process on
`127.0.0.1:8075`, with the app dir at `/var/www/droids`. That process serves
both the static page and the `/api/` proxy.

## Before anything: the port and the branch

**Port 8075 has not been confirmed free on the droplet.** It was chosen from
the lab980 registry, which is known to be incomplete on ports, and
`provision-site` takes an explicit `--port` on trust. If another HTTP app
holds it, nginx will serve *that* app under this hostname with a 200. Check
first:

```bash
ss -ltn | grep ':8075' ; grep -rn '127.0.0.1:8075' /etc/nginx/sites-available
```

Both silent means free. If it is taken, pick a free one in the 8060+ range and
use it consistently: `--port` below, `PORT=` in `.env`, and
`DROIDS_PORT=<port>` in the environment of every `droids` command until the
default in `bin/droids` is changed in the repo.

**`droids deploy` syncs to `origin/main`.** If the repo has no `main` yet,
create it from the working branch and make it the default on GitHub, or
deploy with `DROIDS_BRANCH=<branch> droids deploy` until it exists.

## One-time bring-up (on the droplet, as root)

```bash
provision-site droids ivjames/droids --port 8075   # DNS + dir + clone + nginx (:80) + certbot
cd /var/www/droids
$EDITOR .env                         # provision-site seeded PORT; add ANTHROPIC_API_KEY
ln -sf /var/www/droids/bin/droids /usr/local/bin/droids
droids deploy                        # venv, pip install, first pm2 start, probe, save
droids mic                           # allow the microphone on this vhost
droids status
```

What each step is doing:

- **`provision-site`** creates the DNS A record, clones the repo, writes an
  HTTP-only vhost on `:80`, reloads nginx, waits for DNS, and only then runs
  `certbot --nginx -d droids.lab980.com --redirect`, which adds the `:443`
  block. No TLS configuration exists before certbot writes it. If DNS has not
  propagated it stops with the site on `:80` and prints the certbot command to
  run later; `--no-tls` does the same on purpose.
- **`.env`** gets the Anthropic key, by hand, in an editor. It is the only copy
  of the key on the box; nothing copies it in from anywhere.
- **`droids deploy`** creates `.venv` if missing, installs the pinned
  `requirements.txt`, and — seeing nothing named `droids` registered with pm2 —
  runs the `pm2 start` in `START_CMD` at the top of `bin/droids`. It needs
  `python3 -m venv` to work (`apt-get install python3-venv` if it does not)
  and Python 3.10 or newer.
- **`droids mic`** is what makes the page usable. The shared lab980 security
  headers send `Permissions-Policy: camera=(), microphone=(), geolocation=()`
  and that switches the microphone off for the whole document. `droids mic`
  writes `/etc/nginx/snippets/droids-permissions-microphone.conf`
  (`microphone=(self)`) and includes it directly after the shared snippet in
  this vhost only, then runs `nginx -t` (restoring the backup under
  `/var/backups/` if it fails) and reloads. It must run **after** certbot,
  because the `:443` block is the one that matters, and again after anything
  that rewrites the vhost. `droids mic --dry-run` shows the diff;
  `droids mic --remove` undoes it.

Every pm2 call the CLI makes runs from a scrubbed environment: `env -i` plus
`PATH`, `HOME`, `LANG`, `PM2_HOME` and `TERM` if set, and `PORT` (`8075`).
pm2 copies the environment of the `pm2 start` call into the process and into
`~/.pm2/dump.pm2`, so anything the calling shell holds would live on there.
The process gets `PORT` from the CLI and everything else from `.env`, which
`app.py` reads itself. `pm2 save` runs only after the probe passes and only
when every registered pm2 process is `online` (the box rule), otherwise it
warns and leaves the previous dump alone.

Reboot survival needs the pm2 boot hook installed **once per droplet**
(`pm2 startup systemd -u root --hp /root`, then run the line it prints; verify
`systemctl is-enabled pm2-root` → enabled).

### `.env` keys

| key | what it is |
|---|---|
| `PORT` | `8075` — must match the vhost's `proxy_pass` |
| `ANTHROPIC_API_KEY` | **required.** The key `/api/chat` spends. Without it the page loads and says the droids have nothing to say. |
| `DROIDS_MODEL` | optional; default `claude-opus-5-5` |
| `DROIDS_RATE_PER_MIN` | optional; model calls per client IP per minute, default `20` |
| `DROIDS_RATE_PER_DAY` | optional; per client IP per day, default `300` |
| `DROIDS_GLOBAL_PER_DAY` | optional; whole site per day, default `3000` |

**`.env` is read once at startup.** After editing it: `droids restart`.

One droid line is one model call, and a default conversation is 12. The global
daily cap is the ceiling on what an unauthenticated public endpoint can cost
in a day; set it to what you are willing to spend.

## Deploying updates

Land changes on `main` (via a PR — see `CLAUDE.md`), then on the droplet:

```bash
droids deploy        # sync, pip install, pm2 restart, probe, save
```

`deploy` exits non-zero when nothing answers HTTP on `127.0.0.1:8075`
afterwards (up to `DROIDS_PROBE_TRIES`, default 10, tries a second apart) — a
dead app is a failed deploy, not a warning to read past, and nothing is saved.
The public probe is printed alongside but does not decide the result, because
it also depends on DNS and TLS.

**How `deploy` syncs:** `git fetch` then `git reset --hard origin/<branch>`. A
tracked file edited on the droplet is destroyed silently on the next deploy —
fix it in the repo. `.env` and `.venv/` are gitignored and survive.

**A change to `START_CMD` does not take effect on a plain deploy.** `deploy`
restarts the existing pm2 registration; to pick up new gunicorn flags,
`pm2 delete droids` and then `droids deploy`.

## Check it

```bash
droids status              # HEAD, pm2, local + public probe, hasKey, mic policy, cert
droids logs                # tail pm2 logs for this app
health-check --site droids # the droplet-wide auditor
```

`status` prints the deployed commit; compare it with `origin/main` before
saying a change is live. Then the real test, which no probe can do: open the
page on a phone, press Start, and confirm the browser asks for the microphone.

## Overrides

- `DROIDS_FQDN` — default `droids.lab980.com`
- `DROIDS_BRANCH` — default `main`
- `DROIDS_PORT` — default `8075`
- `DROIDS_PROBE_TRIES` — default `10`
