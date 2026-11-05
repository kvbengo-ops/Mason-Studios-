# How to run the app on your computer (Windows)

Follow these steps in order. You only do Part 1 and Part 2 once.

Running it this way is **free** — it uses fake video results, so nothing is charged.

---

## Part 1 — Install the tools (one time)

Install these four programs. Accept the default options when installing.

1. **Git** — https://git-scm.com/download/win
2. **Docker Desktop** — https://www.docker.com/products/docker-desktop/
3. **Bun** — open **PowerShell** (press the Windows key, type `PowerShell`, press Enter) and paste:
   ```powershell
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```
4. **Go** — https://go.dev/dl/ (pick the Windows installer)

Restart your computer after installing everything.

---

## Part 2 — Get the code and set it up (one time)

1. Open **PowerShell**.
2. Download the code:
   ```powershell
   git clone <your-repo-url> ugc-pipeline
   cd ugc-pipeline
   ```
3. Open **Docker Desktop** and wait until it says it is running.
4. Back in PowerShell, paste these one at a time and wait for each to finish:
   ```powershell
   bun install
   bun run db:start
   bun run db:env
   ```
   `db:start` can take several minutes the first time — it is downloading the database.

---

## Part 3 — Start the app (every time)

You need **two** PowerShell windows open at the same time.

1. Make sure **Docker Desktop** is open and running.
2. In the project folder, start the database:
   ```powershell
   bun run db:start
   ```
3. **Window 1** — start the website:
   ```powershell
   cd web
   bun install
   bun run dev
   ```
4. **Window 2** — open a new PowerShell, go to the project folder, then start the worker:
   ```powershell
   cd worker
   go run ./cmd/worker
   ```
5. Open your browser and go to **http://localhost:9000**

Leave both windows open while you use the app. To stop, click each window and press
`Ctrl + C`.

---

## Part 4 — Make your account an admin (one time)

1. On http://localhost:9000, **sign up** with any email and password.
2. Open **http://127.0.0.1:54323** in your browser (this is the database viewer).
3. Click **Table Editor** on the left, then click **profiles**.
4. Find your row. Change **role** to `admin` and **status** to `active`. Save.
5. Go back to http://localhost:9000 and refresh.

---

## Useful links while it is running

| What              | Address                |
| ----------------- | ---------------------- |
| The app           | http://localhost:9000  |
| Database viewer   | http://127.0.0.1:54323 |
| Test email inbox  | http://127.0.0.1:54324 |

---

## If something goes wrong

- **"Docker is not running"** — open Docker Desktop and wait for it to finish starting.
- **`bun` or `go` "is not recognized"** — restart your computer, then try again.
- **The page won't load** — check that both PowerShell windows are still running.
- **Something is still broken** — stop both windows (`Ctrl + C`), run
  `bun run db:stop`, then start again from Part 3.

---

## For developers

- Full reference: [local-development.md](local-development.md).
- The database here is a separate copy on your computer. It starts empty — no real
  users, projects or videos.
- Never run `bun run db:push:remote` — that changes the real (production) database.
