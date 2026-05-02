#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import https from "node:https";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

const home = os.homedir();
const defaultStatePath = path.join(home, ".reclaude", "state.json");
const defaultCAPath = path.join(home, ".reclaude", "ca.pem");
const defaultClaudeCredentialsPath =
  process.env.RECLAUDE_CLAUDE_CREDENTIALS_PATH ?? path.join(home, ".claude", ".credentials.json");
const defaultReclaudeDevicePath = process.env.RECLAUDE_DEVICE_PATH ?? path.join(home, ".reclaude", "device.json");
const defaultClaudeStatePath = process.env.RECLAUDE_CLAUDE_STATE_PATH ?? path.join(home, ".claude.json");

const options = parseArgs(process.argv.slice(2));
const targetHost = options.targetHost ?? process.env.RECLAUDE_TARGET_HOST ?? "api.anthropic.com";
const listen = parseListen(options.listen ?? process.env.RECLAUDE_GATEWAY_LISTEN ?? "127.0.0.1:58400");
const statePath = options.state ?? process.env.RECLAUDE_STATE_PATH ?? defaultStatePath;
const caPath = options.ca ?? process.env.RECLAUDE_CA_PATH ?? defaultCAPath;
const authMode = options.auth ?? process.env.RECLAUDE_GATEWAY_AUTH ?? "auto";
const accessLogEnabled = parseBoolean(process.env.RECLAUDE_ACCESS_LOG ?? "true");
const explicitAccountDeviceId = process.env.RECLAUDE_ACCOUNT_DEVICE_ID?.trim() ?? "";
const reclaudeBin = process.env.RECLAUDE_BIN?.trim() || defaultReclaudeBin();
let accountDeviceIdCache;

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--version") out.version = true;
    else if (arg === "--listen") out.listen = args[++i];
    else if (arg === "--state") out.state = args[++i];
    else if (arg === "--ca") out.ca = args[++i];
    else if (arg === "--target-host") out.targetHost = args[++i];
    else if (arg === "--auth") out.auth = args[++i];
    else if (arg === "--check") out.check = args[++i] ?? "/api/oauth/profile";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  return [
    "Usage:",
    "  gateway [--listen 127.0.0.1:58400]",
    "  gateway --check /path",
    "  gateway --version",
    "",
    "Environment:",
    "  RECLAUDE_GATEWAY_LISTEN=127.0.0.1:58400",
    "  RECLAUDE_GATEWAY_AUTH=auto|inject|pass",
    "  RECLAUDE_GATEWAY_TOKEN=<token>",
    "  RECLAUDE_DAEMON_ADDR=<host:port>  # optional; overrides state file",
    "  RECLAUDE_STATE_PATH=~/.reclaude/state.json",
    "  RECLAUDE_CA_PATH=~/.reclaude/ca.pem",
    "  RECLAUDE_CLAUDE_CREDENTIALS_PATH=~/.claude/.credentials.json",
    "  RECLAUDE_DEVICE_PATH=~/.reclaude/device.json",
    "  RECLAUDE_CLAUDE_STATE_PATH=~/.claude.json",
    "  RECLAUDE_ACCOUNT_DEVICE_ID=<id>  # optional; overrides auto-detect",
    "  RECLAUDE_BIN=reclaude",
    "  RECLAUDE_ACCESS_LOG=true|false",
  ].join("\n");
}

function packageVersion() {
  try {
    const packageJSON = readJSON(new URL("./package.json", import.meta.url));
    return typeof packageJSON.version === "string" ? packageJSON.version : "unknown";
  } catch {
    return "unknown";
  }
}

function parseListen(value) {
  const index = value.lastIndexOf(":");
  if (index === -1) return { host: "127.0.0.1", port: Number(value) };
  const host = value.slice(0, index) || "127.0.0.1";
  const port = Number(value.slice(index + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid listen address: ${value}`);
  }
  return { host, port };
}

function parseBoolean(value) {
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function parseAccountDeviceId(value) {
  const text = String(value ?? "").trim();
  if (/^\d+$/.test(text)) return Number(text);
  return text;
}

function defaultReclaudeBin() {
  const localBin = path.join(home, ".local", "bin", "reclaude");
  if (fs.existsSync(localBin)) return localBin;
  return "reclaude";
}

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveDaemonAddress() {
  const explicit = process.env.RECLAUDE_DAEMON_ADDR?.trim();
  if (explicit) return normalizeHostPort(explicit);

  const state = readJSON(statePath);
  const port = state.daemon?.port;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid daemon.port in ${statePath}`);
  }
  return net.joinHostPort ? net.joinHostPort("127.0.0.1", String(port)) : `127.0.0.1:${port}`;
}

function normalizeHostPort(value) {
  if (/^\[.*\]:\d+$/.test(value) || /^[^:]+:\d+$/.test(value)) return value;
  return `${value}:58391`;
}

function loadToken() {
  if (authMode === "pass") return { token: null, source: "pass-through" };

  const envToken = process.env.RECLAUDE_GATEWAY_TOKEN?.trim();
  if (envToken) return { token: envToken, source: "env:RECLAUDE_GATEWAY_TOKEN" };

  if (fs.existsSync(defaultReclaudeDevicePath)) {
    const device = readJSON(defaultReclaudeDevicePath);
    const token = device.sk;
    if (typeof token === "string" && token.trim()) {
      return { token: token.trim(), source: defaultReclaudeDevicePath };
    }
  }

  if (fs.existsSync(defaultClaudeCredentialsPath)) {
    const credentials = readJSON(defaultClaudeCredentialsPath);
    const token = credentials.claudeAiOauth?.accessToken;
    if (typeof token === "string" && token.trim()) {
      return { token: token.trim(), source: defaultClaudeCredentialsPath };
    }
  }

  if (authMode === "inject") {
    throw new Error("No Claude/reclaude token found for auth injection");
  }
  return { token: null, source: "pass-through:no-token-found" };
}

function loadClaudeState() {
  if (!fs.existsSync(defaultClaudeStatePath)) return {};
  try {
    return readJSON(defaultClaudeStatePath);
  } catch {
    return {};
  }
}

function loadClaudeIdentity() {
  const claudeState = loadClaudeState();
  return {
    deviceId: typeof claudeState.userID === "string" ? claudeState.userID : "",
    accountUuid:
      typeof claudeState.oauthAccount?.accountUuid === "string" ? claudeState.oauthAccount.accountUuid : "",
    accountDeviceId: loadAccountDeviceId(),
  };
}

function loadAccountDeviceId() {
  if (explicitAccountDeviceId) return explicitAccountDeviceId;
  if (accountDeviceIdCache !== undefined) return accountDeviceIdCache;
  accountDeviceIdCache = discoverAccountDeviceId();
  return accountDeviceIdCache;
}

function discoverAccountDeviceId() {
  const result = spawnSync(reclaudeBin, ["org", "list"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 5000,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const activeLine = output.split(/\r?\n/).find((line) => /^\s*\*\s+\d+\b/.test(line));
  const match = activeLine?.match(/^\s*\*\s+(\d+)\b/);
  return match?.[1] ?? "";
}

function usageTargets() {
  const claudeState = loadClaudeState();
  const orgUuid = claudeState.oauthAccount?.organizationUuid;
  const targets = [
    { path: "/api/oauth/usage", name: "Claude OAuth usage" },
    { path: "/api/claude_code/policy_limits", name: "Claude Code policy limits" },
    { path: "/api/oauth/account/settings", name: "OAuth account settings" },
    { path: "/api/oauth/profile", name: "OAuth profile" },
    { path: "/api/rate-limits", name: "Rate limits" },
  ];

  if (typeof orgUuid === "string" && orgUuid.trim()) {
    targets.push(
      {
        path: `/api/oauth/organizations/${orgUuid}/referral/eligibility?campaign=claude_code_guest_pass`,
        name: "Guest pass eligibility",
      },
      { path: `/api/oauth/organizations/${orgUuid}/overage_credit_grant`, name: "Overage credit grant" },
      { path: `/api/oauth/organizations/${orgUuid}/prepaid/credits`, name: "Prepaid credits" },
      { path: `/api/oauth/organizations/${orgUuid}/prepaid/bundles`, name: "Prepaid bundles" },
      { path: `/api/oauth/organizations/${orgUuid}/overage_spend_limit`, name: "Overage spend limit" },
    );
  }

  return { orgUuid, targets };
}

function waitForConnect(socket) {
  return new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

function readUntil(socket, marker, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${JSON.stringify(marker)}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    }

    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const index = buf.indexOf(marker);
      if (index !== -1) {
        cleanup();
        resolve({
          head: buf.subarray(0, index + marker.length).toString("utf8"),
          rest: buf.subarray(index + marker.length),
        });
      }
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    function onEnd() {
      cleanup();
      resolve({ head: buf.toString("utf8"), rest: Buffer.alloc(0) });
    }

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

function readAll(stream, initial = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    const chunks = initial.length ? [initial] : [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function openReclaudeTLS() {
  const daemonAddr = resolveDaemonAddress();
  const [daemonHost, daemonPort] = splitHostPort(daemonAddr);
  const socket = net.connect({ host: daemonHost, port: Number(daemonPort) });
  await waitForConnect(socket);

  socket.write(
    [
      `CONNECT ${targetHost}:443 HTTP/1.1`,
      `Host: ${targetHost}:443`,
      "User-Agent: reclaude-cliproxy-gateway/1.0",
      "Proxy-Connection: keep-alive",
      "",
      "",
    ].join("\r\n"),
  );

  const { head, rest } = await readUntil(socket, "\r\n\r\n");
  const statusLine = head.split("\r\n")[0];
  if (!/^HTTP\/\d(?:\.\d)?\s+200\b/i.test(statusLine)) {
    socket.destroy();
    throw new Error(`reclaude CONNECT failed: ${statusLine}`);
  }
  if (rest.length > 0) {
    socket.destroy();
    throw new Error(`Unexpected bytes after CONNECT: ${rest.length}`);
  }

  const caPEM = fs.readFileSync(caPath, "utf8");
  const secure = tls.connect({
    socket,
    servername: targetHost,
    ca: [...tls.rootCertificates, caPEM],
    rejectUnauthorized: true,
    ALPNProtocols: ["http/1.1"],
  });
  await new Promise((resolve, reject) => {
    secure.once("secureConnect", resolve);
    secure.once("error", reject);
  });
  return secure;
}

function splitHostPort(addr) {
  if (addr.startsWith("[")) {
    const end = addr.indexOf("]");
    return [addr.slice(1, end), addr.slice(end + 2)];
  }
  const index = addr.lastIndexOf(":");
  return [addr.slice(0, index), addr.slice(index + 1)];
}

function buildUpstreamHeaders(req, bodyLength) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (["host", "connection", "proxy-connection", "keep-alive", "transfer-encoding"].includes(lower)) {
      continue;
    }
    headers[lower] = Array.isArray(value) ? value.join(", ") : value;
  }

  headers.host = targetHost;
  headers.connection = "close";
  headers["content-length"] = String(bodyLength);

  const { token } = loadToken();
  if (token) {
    delete headers["x-api-key"];
    headers.authorization = `Bearer ${token}`;
  }

  return headers;
}

function parseMaybeJSON(value) {
  if (typeof value !== "string") return value && typeof value === "object" ? value : {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseLegacyUserID(value) {
  if (typeof value !== "string") return {};
  const match = value.match(/^user_([0-9a-f]{64})_account_([0-9a-f-]{36})_session_([0-9a-f-]{36})$/i);
  if (!match) return {};
  return {
    device_id: match[1],
    account_uuid: match[2],
    session_id: match[3],
  };
}

function normalizeClaudeCodeMetadata(req, body) {
  if (body.length === 0) return { body };

  const localURL = new URL(req.url, "http://127.0.0.1");
  if (localURL.pathname !== "/v1/messages") return { body };

  const contentType = String(req.headers["content-type"] ?? "");
  if (contentType && !contentType.toLowerCase().includes("json")) return { body };

  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return { body };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { body };

  const existingMetadata =
    payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
      ? payload.metadata
      : {};
  const existingUserID = existingMetadata.user_id;
  const parsedUserID = parseMaybeJSON(existingUserID);
  const legacyUserID = parseLegacyUserID(existingUserID);
  const identity = loadClaudeIdentity();
  const sessionId =
    String(req.headers["x-claude-code-session-id"] ?? "").trim() ||
    parsedUserID.session_id ||
    legacyUserID.session_id ||
    crypto.randomUUID();

  const normalizedUserID = {
    ...parsedUserID,
    device_id: identity.deviceId || parsedUserID.device_id || legacyUserID.device_id || "",
    account_uuid: identity.accountUuid || parsedUserID.account_uuid || legacyUserID.account_uuid || "",
    ...(identity.accountDeviceId || parsedUserID.account_device_id
      ? { account_device_id: parseAccountDeviceId(identity.accountDeviceId || parsedUserID.account_device_id) }
      : {}),
    session_id: sessionId,
  };

  if (!normalizedUserID.device_id || !normalizedUserID.account_uuid || !normalizedUserID.session_id) {
    return { body };
  }

  payload.metadata = {
    ...existingMetadata,
    user_id: JSON.stringify(normalizedUserID),
  };

  const normalizedBody = Buffer.from(JSON.stringify(payload));
  return { body: normalizedBody };
}

function filterResponseHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (["connection", "proxy-connection", "keep-alive", "transfer-encoding"].includes(lower)) {
      continue;
    }
    out[lower] = value;
  }
  return out;
}

class ReclaudeAgent extends https.Agent {
  createConnection(_options, callback) {
    openReclaudeTLS().then((socket) => callback(null, socket), callback);
  }
}

const agent = new ReclaudeAgent({ keepAlive: false });

function requestUpstream(method, requestPath, headers, body) {
  return new Promise((resolve, reject) => {
    const upstreamReq = https.request(
      {
        host: targetHost,
        servername: targetHost,
        method,
        path: requestPath,
        headers,
        agent,
      },
      (upstreamRes) => resolve(upstreamRes),
    );
    upstreamReq.once("error", reject);
    upstreamReq.end(body.length > 0 ? body : undefined);
  });
}

async function collectUpstream(method, requestPath, headers, body) {
  const upstreamRes = await requestUpstream(method, requestPath, headers, body);
  const responseBody = await readAll(upstreamRes);
  const responseHeaders = {};
  for (const [key, value] of Object.entries(upstreamRes.headers)) {
    responseHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return {
    statusCode: upstreamRes.statusCode ?? 502,
    statusMessage: upstreamRes.statusMessage ?? "Bad Gateway",
    headers: responseHeaders,
    body: responseBody,
  };
}

async function forwardRequest(req, res) {
  const localURL = new URL(req.url, "http://127.0.0.1");
  const isReadOnlyLocal = req.method === "GET" || req.method === "HEAD";

  if (isReadOnlyLocal && localURL.pathname === "/__health") {
    const tokenInfo = loadToken();
    const body = JSON.stringify({
      ok: true,
      targetHost,
      daemon: resolveDaemonAddress(),
      caPath,
      auth: tokenInfo.token ? `inject:${tokenInfo.source}` : tokenInfo.source,
    }, null, 2);
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }

  if (isReadOnlyLocal && (localURL.pathname === "/__usage" || localURL.pathname === "/__usage.json")) {
    await handleUsage(res, localURL.pathname === "/__usage.json", req.method === "HEAD");
    return;
  }

  const incomingBody = await readAll(req);
  const { body } = normalizeClaudeCodeMetadata(req, incomingBody);
  const headers = buildUpstreamHeaders(req, body.length);
  const upstreamRes = await requestUpstream(req.method, req.url, headers, body);
  res.writeHead(
    upstreamRes.statusCode ?? 502,
    upstreamRes.statusMessage ?? "Bad Gateway",
    filterResponseHeaders(upstreamRes.headers),
  );
  await pipeResponse(upstreamRes, res);
}

function pipeResponse(upstreamRes, res) {
  return new Promise((resolve, reject) => {
    let settled = false;

    function finish(error) {
      if (settled) return;
      settled = true;
      upstreamRes.off("error", onError);
      res.off("error", onError);
      res.off("finish", onFinish);
      res.off("close", onClose);
      if (error) reject(error);
      else resolve();
    }

    function onError(error) {
      finish(error);
    }

    function onFinish() {
      finish();
    }

    function onClose() {
      finish();
    }

    upstreamRes.once("error", onError);
    res.once("error", onError);
    res.once("finish", onFinish);
    res.once("close", onClose);
    upstreamRes.pipe(res);
  });
}

function writeJSON(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function safeRequestTarget(req) {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    return `${url.pathname}${url.search ? "?<query>" : ""}`;
  } catch {
    return "<invalid-url>";
  }
}

function logAccess(req, res, startedAt, error) {
  if (!accessLogEnabled) return;
  const durationMs = Date.now() - startedAt;
  const statusCode = res.statusCode || 502;
  const remote = req.socket?.remoteAddress ?? "-";
  const message = [
    new Date().toISOString(),
    remote,
    req.method,
    safeRequestTarget(req),
    statusCode,
    `${durationMs}ms`,
  ];
  if (error) message.push(`error=${JSON.stringify(error.message)}`);
  console.log(message.join(" "));
}

async function handleServerRequest(req, res) {
  const startedAt = Date.now();
  let caughtError;
  try {
    await forwardRequest(req, res);
  } catch (error) {
    caughtError = error;
    if (!res.headersSent) {
      writeJSON(res, 502, { error: error.message });
    } else {
      res.destroy(error);
    }
  } finally {
    logAccess(req, res, startedAt, caughtError);
  }
}

function redactJSON(value, keyPath = "") {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 10).map((item, index) => redactJSON(item, `${keyPath}.${index}`));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJSON(item, `${keyPath}.${key}`)]));
  }
  if (typeof value !== "string") return String(value);
  if (/(token|secret|authorization|api[-_]?key|refresh|password|sk|credential)/i.test(keyPath)) return "<redacted>";
  if (value.includes("@")) return "<email:redacted>";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return `<uuid:${value.slice(0, 8)}...>`;
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}${url.search ? "?<redacted-query>" : ""}`;
    } catch {}
  }
  if (value.length > 180) return `${value.slice(0, 140)}...<truncated:${value.length}>`;
  return value;
}

function redactText(value) {
  return String(value)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email:redacted>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (uuid) => {
      return `<uuid:${uuid.slice(0, 8)}...>`;
    })
    .replace(/\b(Bearer\s+)?[A-Za-z0-9_-]{32,}\.[A-Za-z0-9._-]{16,}\b/g, "<token:redacted>");
}

function interestingFields(json) {
  const hits = {};
  const interesting =
    /(usage|utili[sz]ation|quota|limit|billing|subscription|remaining|reset|pass|credit|overage|eligible|balance|amount|currency|tier|rate)/i;

  function visit(value, keyPath) {
    if (keyPath && interesting.test(keyPath)) {
      hits[keyPath] = redactJSON(value, keyPath);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.slice(0, 10).forEach((item, index) => visit(item, `${keyPath}[${index}]`));
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      visit(nested, keyPath ? `${keyPath}.${key}` : key);
    }
  }

  visit(json, "");
  return hits;
}

function summarizeBody(headers, body) {
  const text = body.toString("utf8");
  const contentType = String(headers["content-type"] ?? "");
  if (!contentType.includes("json")) {
    return {
      kind: "text",
      preview: redactText(text.replace(/\s+/g, " ").slice(0, 500)),
    };
  }

  try {
    const json = JSON.parse(text);
    return {
      kind: "json",
      topLevelKeys: json && typeof json === "object" && !Array.isArray(json) ? Object.keys(json).slice(0, 80) : [],
      interestingFields: interestingFields(json),
      smallBody: text.length <= 5000 ? redactJSON(json) : undefined,
    };
  } catch (error) {
    return {
      kind: "invalid-json",
      parseError: error.message,
      preview: redactText(text.replace(/\s+/g, " ").slice(0, 500)),
    };
  }
}

function buildUsageHeaders(token) {
  const headers = {
    accept: "application/json",
    "accept-encoding": "identity",
    "anthropic-client-platform": "cli",
    "anthropic-version": "2023-06-01",
    connection: "close",
    "content-length": "0",
    "content-type": "application/json",
    host: targetHost,
    "user-agent": "Claude-Code/2.1.123 reclaude-cliproxy-gateway-usage/1.0",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function collectUsageSnapshot() {
  const tokenInfo = loadToken();
  const { orgUuid, targets } = usageTargets();
  const snapshot = {
    ok: true,
    generatedAt: new Date().toISOString(),
    targetHost,
    daemon: resolveDaemonAddress(),
    caPath,
    auth: tokenInfo.token ? `inject:${tokenInfo.source}` : tokenInfo.source,
    orgUuid: orgUuid ? redactText(orgUuid) : null,
    results: [],
  };

  if (!tokenInfo.token) {
    snapshot.ok = false;
    snapshot.error = "No Claude/reclaude token is available, so usage endpoints cannot be queried.";
    return snapshot;
  }

  for (const target of targets) {
    try {
      const response = await collectUpstream("GET", target.path, buildUsageHeaders(tokenInfo.token), Buffer.alloc(0));
      snapshot.results.push({
        name: target.name,
        request: `GET ${redactText(target.path)}`,
        statusCode: response.statusCode,
        statusMessage: response.statusMessage,
        contentType: response.headers["content-type"] ?? null,
        retryAfter: response.headers["retry-after"] ?? null,
        bodyBytes: response.body.length,
        summary: summarizeBody(response.headers, response.body),
      });
    } catch (error) {
      snapshot.ok = false;
      snapshot.results.push({
        name: target.name,
        request: `GET ${redactText(target.path)}`,
        error: error.message,
      });
    }
  }

  return snapshot;
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function statusClass(result) {
  if (result.error) return "bad";
  if (result.statusCode >= 200 && result.statusCode < 300) return "ok";
  if (result.statusCode === 429) return "warn";
  if (result.statusCode >= 300 && result.statusCode < 500) return "warn";
  return "bad";
}

function renderFields(fields) {
  const entries = Object.entries(fields ?? {});
  if (entries.length === 0) return '<tr><td class="muted" colspan="2">No quota-like fields found in this response.</td></tr>';
  return entries
    .map(([key, value]) => {
      return `<tr><th>${escapeHTML(key)}</th><td><code>${escapeHTML(JSON.stringify(value))}</code></td></tr>`;
    })
    .join("");
}

function renderUsageHTML(snapshot) {
  const rows = snapshot.results
    .map((result) => {
      const klass = statusClass(result);
      const status = result.error ? "error" : `${result.statusCode} ${result.statusMessage}`;
      return `<tr>
        <td>${escapeHTML(result.name)}</td>
        <td><code>${escapeHTML(result.request)}</code></td>
        <td><span class="pill ${klass}">${escapeHTML(status)}</span></td>
        <td>${escapeHTML(result.retryAfter ?? "")}</td>
        <td>${escapeHTML(result.bodyBytes ?? "")}</td>
      </tr>`;
    })
    .join("");

  const cards = snapshot.results
    .map((result) => {
      const klass = statusClass(result);
      const status = result.error ? result.error : `${result.statusCode} ${result.statusMessage}`;
      const summary = result.summary
        ? `<table class="fields">${renderFields(result.summary.interestingFields)}</table>
           <details>
             <summary>Redacted response summary</summary>
             <pre>${escapeHTML(JSON.stringify(result.summary, null, 2))}</pre>
           </details>`
        : `<pre>${escapeHTML(result.error ?? "No summary")}</pre>`;
      return `<section class="card">
        <div class="card-head">
          <div>
            <h2>${escapeHTML(result.name)}</h2>
            <code>${escapeHTML(result.request)}</code>
          </div>
          <span class="pill ${klass}">${escapeHTML(status)}</span>
        </div>
        ${summary}
      </section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ReClaude Usage</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { max-width: 1120px; margin: 0 auto; padding: 28px 20px 48px; }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 24px; }
    h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.15; letter-spacing: 0; }
    h2 { margin: 0 0 6px; font-size: 16px; line-height: 1.25; letter-spacing: 0; }
    a.button { border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 6px; color: CanvasText; display: inline-block; padding: 8px 12px; text-decoration: none; white-space: nowrap; }
    .meta { color: color-mix(in srgb, CanvasText 64%, transparent); display: grid; gap: 4px; font-size: 13px; }
    .meta code, td code, .card code { overflow-wrap: anywhere; }
    table { border-collapse: collapse; width: 100%; }
    .overview { border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 8px; overflow: hidden; margin-bottom: 20px; }
    .overview th, .overview td { border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent); font-size: 13px; padding: 10px 12px; text-align: left; vertical-align: top; }
    .overview tr:last-child th, .overview tr:last-child td { border-bottom: 0; }
    .pill { border-radius: 999px; display: inline-flex; font-size: 12px; font-weight: 700; line-height: 1; padding: 5px 8px; white-space: nowrap; }
    .pill.ok { background: color-mix(in srgb, #15803d 18%, Canvas); color: #15803d; }
    .pill.warn { background: color-mix(in srgb, #b45309 20%, Canvas); color: #b45309; }
    .pill.bad { background: color-mix(in srgb, #b91c1c 18%, Canvas); color: #b91c1c; }
    .card { border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 8px; margin-top: 16px; padding: 16px; }
    .card-head { align-items: flex-start; display: flex; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
    .fields th, .fields td { border-top: 1px solid color-mix(in srgb, CanvasText 10%, transparent); font-size: 13px; padding: 8px 0; text-align: left; vertical-align: top; }
    .fields th { color: color-mix(in srgb, CanvasText 72%, transparent); font-weight: 600; padding-right: 14px; width: 34%; }
    pre { background: color-mix(in srgb, CanvasText 5%, Canvas); border-radius: 6px; font-size: 12px; line-height: 1.45; max-height: 420px; overflow: auto; padding: 12px; white-space: pre-wrap; }
    details { margin-top: 12px; }
    summary { cursor: pointer; font-size: 13px; font-weight: 650; }
    .muted { color: color-mix(in srgb, CanvasText 58%, transparent); font-size: 13px; }
    @media (max-width: 720px) {
      header, .card-head { display: block; }
      a.button { margin-top: 12px; }
      .overview { overflow-x: auto; }
      main { padding: 20px 14px 36px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>ReClaude Usage</h1>
        <div class="meta">
          <div>Generated: <code>${escapeHTML(snapshot.generatedAt)}</code></div>
          <div>Target: <code>https://${escapeHTML(snapshot.targetHost)}</code></div>
          <div>Daemon: <code>${escapeHTML(snapshot.daemon)}</code></div>
          <div>Auth: <code>${escapeHTML(snapshot.auth)}</code></div>
          <div>Org: <code>${escapeHTML(snapshot.orgUuid ?? "not found")}</code></div>
        </div>
      </div>
      <div>
        <a class="button" href="/__usage">Refresh</a>
        <a class="button" href="/__usage.json">JSON</a>
      </div>
    </header>
    ${snapshot.error ? `<p class="pill bad">${escapeHTML(snapshot.error)}</p>` : ""}
    <table class="overview">
      <thead><tr><th>Name</th><th>Request</th><th>Status</th><th>Retry-After</th><th>Bytes</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${cards}
  </main>
</body>
</html>`;
}

async function handleUsage(res, asJSON, headOnly = false) {
  if (headOnly) {
    res.writeHead(200, {
      "content-type": asJSON ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end();
    return;
  }

  const snapshot = await collectUsageSnapshot();
  if (asJSON) {
    const body = JSON.stringify(snapshot, null, 2);
    res.writeHead(snapshot.ok ? 200 : 502, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    res.end(body);
    return;
  }

  const body = renderUsageHTML(snapshot);
  res.writeHead(snapshot.ok ? 200 : 502, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

async function check(pathname) {
  const fakeReq = {
    method: "GET",
    url: pathname,
    headers: {
      accept: "application/json",
      "user-agent": "reclaude-cliproxy-gateway-check/1.0",
    },
    on(event, cb) {
      if (event === "end") queueMicrotask(cb);
      return this;
    },
    once(event, cb) {
      if (event === "end") queueMicrotask(cb);
      return this;
    },
  };
  const body = Buffer.alloc(0);
  const headers = buildUpstreamHeaders(fakeReq, body.length);
  const parsed = await collectUpstream("GET", pathname, headers, body);
  const responseBody = parsed.body;
  let summary = responseBody.toString("utf8").replace(/\s+/g, " ").slice(0, 400);
  if ((parsed.headers["content-type"] ?? "").includes("json")) {
    try {
      summary = redactJSON(JSON.parse(responseBody.toString("utf8")));
    } catch {}
  }
  console.log(JSON.stringify({
    request: `GET ${pathname}`,
    statusCode: parsed.statusCode,
    statusMessage: parsed.statusMessage,
    contentType: parsed.headers["content-type"] ?? null,
    bodyBytes: responseBody.length,
    summary,
  }, null, 2));
}

function installShutdownHandlers(server) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      console.log(`${new Date().toISOString()} received ${signal}, shutting down`);
      server.close(() => {
        console.log(`${new Date().toISOString()} server closed`);
        process.exit(0);
      });
      setTimeout(() => {
        console.error(`${new Date().toISOString()} forced shutdown after timeout`);
        process.exit(1);
      }, 10000).unref();
    });
  }
}

if (options.help) {
  console.log(usage());
} else if (options.version) {
  console.log(packageVersion());
} else if (options.check) {
  await check(options.check);
} else {
  const server = http.createServer(handleServerRequest);
  installShutdownHandlers(server);
  server.listen(listen.port, listen.host, () => {
    const tokenInfo = loadToken();
    console.log(`gateway listening on http://${listen.host}:${listen.port}`);
    console.log(`target: https://${targetHost}`);
    console.log(`daemon: ${resolveDaemonAddress()}`);
    console.log(`auth: ${tokenInfo.token ? `inject:${tokenInfo.source}` : tokenInfo.source}`);
  });
}
