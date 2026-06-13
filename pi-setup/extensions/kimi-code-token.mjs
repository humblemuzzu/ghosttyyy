#!/usr/bin/env node
import { mkdirSync, openSync, closeSync, rmSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const KIMI_HOME = process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code");
const CREDENTIALS_PATH = process.env.KIMI_CODE_CREDENTIALS || join(KIMI_HOME, "credentials", "kimi-code.json");
const LOCK_DIR = join(KIMI_HOME, "credentials", ".kimi-code-token.lock");
const REFRESH_SKEW_SECONDS = 90;

function fail(message) {
  console.error(`[kimi-code-token] ${message}`);
  process.exit(1);
}

function decodeJwtPayload(token) {
  const payload = token?.split(".")?.[1];
  if (!payload) fail("token is not a JWT");
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64url").toString("utf8"));
}

function readCredentials() {
  try {
    return JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));
  } catch (error) {
    fail(`failed to read ${CREDENTIALS_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeCredentials(credentials) {
  mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true });
  const tmpPath = `${CREDENTIALS_PATH}.tmp-${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  rmSync(CREDENTIALS_PATH, { force: true });
  writeFileSync(CREDENTIALS_PATH, readFileSync(tmpPath), { mode: 0o600 });
  chmodSync(CREDENTIALS_PATH, 0o600);
  rmSync(tmpPath, { force: true });
}

async function withLock(fn) {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      mkdirSync(LOCK_DIR, { mode: 0o700 });
      const fd = openSync(join(LOCK_DIR, "pid"), "w", 0o600);
      try {
        return await fn();
      } finally {
        closeSync(fd);
        rmSync(LOCK_DIR, { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code !== "EEXIST" || Date.now() > deadline) {
        fail(`failed to acquire token refresh lock: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function accessTokenIsFresh(credentials) {
  if (!credentials.access_token) return false;
  const exp = Number(credentials.expires_at || decodeJwtPayload(credentials.access_token).exp || 0);
  return exp > Math.floor(Date.now() / 1000) + REFRESH_SKEW_SECONDS;
}

async function refreshCredentials(credentials) {
  if (!credentials.refresh_token) fail("missing refresh_token; run `kimi login` again");

  const refreshPayload = decodeJwtPayload(credentials.refresh_token);
  const clientId = refreshPayload.client_id;
  if (!clientId) fail("refresh token is missing client_id");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credentials.refresh_token,
    client_id: clientId,
  });

  const oauthHost = process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST || "https://auth.kimi.com";
  const response = await fetch(`${oauthHost.replace(/\/$/, "")}/api/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "KimiCLI/1.5",
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    fail(`refresh failed: HTTP ${response.status}${text ? ` ${text.slice(0, 300)}` : ""}`);
  }

  const data = await response.json();
  if (!data.access_token) fail("refresh response missing access_token");

  const accessPayload = decodeJwtPayload(data.access_token);
  const refreshed = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || credentials.refresh_token,
    expires_at: Number(accessPayload.exp || Math.floor(Date.now() / 1000) + Number(data.expires_in || 900)),
    scope: data.scope || credentials.scope || "kimi-code",
    token_type: data.token_type || credentials.token_type || "Bearer",
    expires_in: Number(data.expires_in || credentials.expires_in || 900),
  };
  writeCredentials(refreshed);
  return refreshed;
}

const credentials = await withLock(async () => {
  const current = readCredentials();
  return accessTokenIsFresh(current) ? current : await refreshCredentials(current);
});

if (!credentials.access_token) fail("missing access_token");
process.stdout.write(credentials.access_token);
