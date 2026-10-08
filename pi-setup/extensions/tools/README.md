# tools extension

custom tool implementations for pi. replaces built-in tools with versions that add file mutex locking, change tracking, secret scrubbing and permission rules.

## deps

```bash
npm install
bun test
```

the pi packages in `package.json` are `file:` links to the installed pi, so tests run against the real, patched pi-tui. pi doesn't auto-install deps for local extensions; `install.sh` runs `npm install --no-package-lock` in the deployed copy.
