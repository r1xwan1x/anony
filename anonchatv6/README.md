# AnonChat v6 — FULL classic

## Local dev
```
npm i
npm start
```

## Railway
1. Push this folder to a GitHub repo.
2. Create a new Railway project -> Deploy from GitHub.
3. Set environment variables (Settings -> Variables):
   - `ADMIN_KEY` (choose a strong value)
   - `SAVE_RAW_IP` = `1` (or `0` to hash IPs)
   - `IP_SALT` = some long random string (if hashing)
   - `FILTER_MODE` = `soft` or `block`
   - `MAX_FILE_MB` = `12`
4. Add **Persistent Storage**:
   - Volume 1: mount path `/app/data`
   - Volume 2: mount path `/app/uploads`
5. Deploy. Railway will run `npm start` which runs the migration and starts the server.

Open the public URL Railway gives you. Client uses Socket.IO at `/realtime`.
