# Deploying

Vercel for the web client; Render for the game server, Postgres and Redis. Two
accounts, no Docker, no server to patch.

| Piece              | Where            | Cost                |
| ------------------ | ---------------- | ------------------- |
| Web client         | Vercel           | free                |
| Game server        | Render (Free)    | free — kept awake   |
| Postgres           | Render           | free — 90-day limit |
| Redis              | Render Key Value | free                |
| SMS one-time codes | Twilio or MSG91  | pay per message     |

Do it in this order. Render needs the Vercel URL and Vercel needs the Render
URL, so there is one deliberate back-and-forth at the end.

---

## 1. Render — server, database, Redis

1. [render.com](https://render.com) → **New → Blueprint** → pick this repo.
   It reads `render.yaml` and creates three things: the `poker-server` service,
   a `poker-db` Postgres, and a `poker-redis` key-value store. `DATABASE_URL`
   and `REDIS_URL` wire themselves to the other two; `JWT_SECRET` and
   `JWT_REFRESH_SECRET` are generated for you.

2. It will ask for the values marked `sync: false`:

   | Variable        | What to put                                                |
   | --------------- | ---------------------------------------------------------- |
   | `WEB_ORIGIN`    | leave blank for now — you get it in step 3                 |
   | `SMS_PROVIDER`  | `twilio` or `msg91`                                        |
   | `SMS_API_KEY`   | Twilio: `AC…sid:authtoken` · MSG91: the authkey            |
   | `SMS_SENDER_ID` | Twilio: your `+1555…` number · MSG91: the flow template id |
   | `KEEPALIVE_URL` | leave blank — it uses `RENDER_EXTERNAL_URL` by itself      |

3. Deploy. The first build takes a few minutes. Then check it:

   ```bash
   curl https://poker-server.onrender.com/health
   # {"status":"ok","uptimeSeconds":8,"version":"..."}
   ```

### 1b. Create the schema

The `DATABASE_URL` Render gave the service is internal — it does not resolve
from your laptop. Copy the **External Database URL** from the `poker-db` page in
the dashboard and run the migration once:

```bash
DATABASE_URL='postgresql://...external...' pnpm --filter @poker/server db:migrate
```

Repeat it any time something under `apps/server/drizzle` changes; Render does
not run it for you.

**Render's free Postgres expires 90 days after creation.** Before then, either
move to a paid instance or `pg_dump` it somewhere — accounts, hand history and
both leaderboards all live in it.

### Staying awake on the free plan

Render sleeps a free instance after 15 minutes with no inbound request, and
waking it takes the better part of a minute. Here that is worse than a slow page
load: every live table is held in the server process, so a spin-down ends every
hand in progress.

So the server keeps itself awake. `apps/server/src/keepalive.ts` asks its own
public URL for `/health` every **14 minutes** — inside the window, with a minute
of slack. The request leaves Render and comes back in, which is what makes it
count as the inbound traffic the idle timer is watching for; a call to
`127.0.0.1` would not.

It configures itself: Render sets `RENDER_EXTERNAL_URL` on every service, and
that is what gets pinged. Nothing to fill in. You will see this in the log at
boot:

```
keep-alive: pinging https://poker-server.onrender.com/health so this instance is not put to sleep.
```

Two limits worth knowing:

- **It prevents sleep, it cannot cure it.** A process that is already asleep is
  not running the timer. If it does go down — a failed deploy, a crash, a
  platform restart — the next real visitor wakes it, slowly, and the pings
  resume from there.
- **Free instances still have a monthly hour budget.** Staying awake spends it
  continuously. If you run out, move to Starter ($7/mo) and set
  `KEEPALIVE_URL=off`; paid instances have no idle timer.

For belt and braces, point [UptimeRobot](https://uptimerobot.com) or
[cron-job.org](https://cron-job.org) at `/health` on a 5-minute interval as well.
Both are free, and unlike the self-ping they can wake an instance that has
already gone down.

**Keep it at one instance** either way. Tables are a `Map` in the process
(`apps/server/src/table/registry.ts`), so a second instance is a second,
different game behind the same table code.

---

## 2. Vercel — the web client

1. [vercel.com](https://vercel.com) → **Add New → Project** → this repo.
2. **Root Directory: `apps/web`.** Turn on _Include files outside the root
   directory_ so the workspace packages come along.
3. `apps/web/vercel.json` already sets the install and build commands; leave
   Framework as Next.js and do not override them.
4. Environment variable:

   ```
   NEXT_PUBLIC_SERVER_URL = https://poker-server.onrender.com
   ```

   Set it for Production, Preview and Development. It is **compiled into the
   browser bundle**, so changing it later means a redeploy, not a restart.

5. Deploy, then note the URL — `https://your-app.vercel.app`.

---

## 3. Close the loop

Back in Render, set `WEB_ORIGIN` to the Vercel URL exactly, no trailing slash:

```
WEB_ORIGIN = https://your-app.vercel.app
```

That one value is both the CORS allow-list and the Socket.IO origin check. Get
it wrong and the site loads fine and can talk to nothing. Save, let Render
redeploy, and you are live.

---

## SMS, so other people can sign in

`SMS_PROVIDER=console` prints the login code to the Render log. Only someone who
can read your Render dashboard can sign in, so it is not a way to run a table.

**Twilio** — buy a number that can send SMS to your players' countries:

```
SMS_PROVIDER=twilio
SMS_API_KEY=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx:your_auth_token
SMS_SENDER_ID=+15551234567
```

**MSG91** — for Indian numbers; create a Flow template with an `OTP` variable:

```
SMS_PROVIDER=msg91
SMS_API_KEY=your_authkey
SMS_SENDER_ID=your_flow_template_id
```

The code is stored only as an argon2 hash in Redis, lasts five minutes, allows
five attempts, and is never logged.

---

## Things that will bite you

**The cookie is `SameSite=None` now, and it has to be.** Vercel and Render are
different sites, so a `Lax` refresh cookie is silently dropped on the way to
`/auth/refresh` — sign-in appears to work and then every session ends at the
first page reload. `cookiePolicyFor` in `apps/server/src/auth/policy.ts` handles
this; local development stays on `Lax` because `Secure` is impossible over plain
http. If you ever move both onto one domain, nothing breaks — `None` works
either way.

**A restart drops live tables.** They are in memory. Accounts, hand history and
the leaderboards are all in Postgres and survive; tables do not. Deploy when
nobody is mid-hand. Players stay signed in and land back in the lobby.

**`NEXT_PUBLIC_SERVER_URL` is baked in at build time.** Redeploy Vercel to
change it.

**Production refuses two settings outright.** `AUTH_STORE=memory` and
`TABLE_RNG_SEED` each make the server exit at boot when `NODE_ENV=production` —
the first loses every account on restart, the second makes every shuffle
predictable. If Render's deploy fails at startup, read the log; it names the
variable.

**Render's free Postgres expires 90 days after it is created**, and it is not a
warning — the database goes. Back it up and move to a paid instance before then:

```bash
pg_dump 'postgresql://...external...' | gzip > poker-backup.sql.gz
```

---

## Before you invite anyone

- [ ] `https://poker-server.onrender.com/health` answers `ok`
- [ ] The Vercel site loads and the lobby is not stuck on "connecting"
- [ ] Sign in from a phone that is not yours, on a real SMS provider
- [ ] **Reload the page after signing in — you are still signed in.** That is
      the cookie test. If it logs you out, `WEB_ORIGIN` or the cookie policy is
      wrong
- [ ] Four browsers at one table play a hand to showdown
- [ ] `/leaderboard` lists it afterwards
- [ ] Render shows one instance, not two
- [ ] The Render log shows the `keep-alive: pinging …` line at boot
- [ ] Come back after 20 minutes of leaving it alone — the site still answers
      immediately, with no cold-start pause

This is play money. There is no payment code in this repo and none should be
added — see [`CLAUDE.md`](./CLAUDE.md).
