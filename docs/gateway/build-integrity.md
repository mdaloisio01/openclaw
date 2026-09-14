# Gateway Build Integrity

Never run npm install in `/home/will/openclaw-source`.

Use `corepack pnpm install` only.

If `node_modules` is polluted or dependency resolution fails, stop before deleting `dist`.

Back up suspicious npm lock/shrinkwrap artifacts before moving them.

Repair install state with `corepack pnpm install --force`.

Do not restart `openclaw-gateway.service` after a failed build.

Do not call activation complete until the live gateway health and runtime identity are proven after restart.

Local gateway build, install, and restart activation paths must fail closed when `package-lock.json` is present or when root `npm-shrinkwrap.json` is untracked or modified.

The currently tracked clean root `npm-shrinkwrap.json` is temporarily allowed because existing release/package workflows still require it. Backup files such as `npm-shrinkwrap.json.bak-*` are evidence for later cleanup review; do not auto-delete, restore, stage, or package them.
