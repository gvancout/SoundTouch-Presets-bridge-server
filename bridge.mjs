import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const configPath = process.env.SOUNDTOUCH_BRIDGE_CONFIG ?? resolve(scriptDirectory, "config.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
validateConfig(config);

let host = config.speakerHost;
const reconnectDelayMs = 3_000;
const recentEvents = new Map();
let stopped = false;
let boseWebSocketConnected = false;
let bonjourProcess;
let healthServer;
let recoveryTimer;
let activePresetNumber;
let lastPlaybackSecond;
let stalledChecks = 0;
let lastRecoveryAt = 0;
let playInProgress = false;
let boseWebSocket;
let websocketGeneration = 0;

const requestedPreset = process.argv[2] === "--play" ? process.argv[3] : undefined;
if (requestedPreset) {
  await playPreset(requestedPreset);
  process.exit(0);
}
const requestedURL = process.argv[2] === "--url" ? process.argv[3] : undefined;
if (requestedURL) {
  await playStream(process.argv[4] ?? "Directe stream", requestedURL);
  process.exit(0);
}

console.log(host ? `[bridge] ${config.speakerName ?? "SoundTouch"} op ${host}` : "[bridge] Wacht op speakeradres vanuit de iOS-app");
for (const [number, preset] of Object.entries(config.presets)) {
  console.log(`[bridge] ${number}: ${preset.name} → ${preset.url}`);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
startHealthServer();
connectWebSocket();
startRecoveryMonitor();

function connectWebSocket() {
  if (stopped || !host) return;
  const generation = websocketGeneration;
  const socket = new WebSocket(`ws://${host}:8080`, "gabbo");
  boseWebSocket = socket;

  socket.addEventListener("open", () => {
    if (generation !== websocketGeneration) return;
    boseWebSocketConnected = true;
    console.log(`[bridge] Verbonden met Bose-websocket (${new Date().toLocaleString("nl-BE")})`);
  });

  socket.addEventListener("message", async event => {
    if (generation !== websocketGeneration) return;
    try {
      const xml = await messageText(event.data);
      const presetNumber = extractPresetNumber(xml);
      if (!presetNumber || !config.presets[presetNumber]) return;

      const now = Date.now();
      if (now - (recentEvents.get(presetNumber) ?? 0) < 1_500) return;
      recentEvents.set(presetNumber, now);

      console.log(`[bridge] Fysieke preset ${presetNumber} gedetecteerd`);
      const delay = Number(config.playDelayMs ?? 1_500);
      console.log(`[bridge] Wacht ${delay} ms tot de Bose zijn presetactie heeft afgerond`);
      await new Promise(resolveDelay => setTimeout(resolveDelay, delay));
      await playPreset(presetNumber);
    } catch (error) {
      console.error(`[bridge] Eventfout: ${error.message}`);
    }
  });

  socket.addEventListener("error", () => {
    if (generation !== websocketGeneration) return;
    console.error("[bridge] Websocketfout; verbinding wordt opnieuw opgebouwd");
  });

  socket.addEventListener("close", () => {
    if (generation !== websocketGeneration) return;
    boseWebSocketConnected = false;
    if (!stopped) {
      console.log(`[bridge] Verbinding gesloten; nieuwe poging over ${reconnectDelayMs / 1000} seconden`);
      setTimeout(connectWebSocket, reconnectDelayMs);
    }
  });
}

function startHealthServer() {
  const port = Number(config.healthPort ?? 8787);
  healthServer = createServer(async (request, response) => {
    if (request.method === "POST" && request.url?.split("?")[0] === "/speaker") {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const speaker = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(speaker.host ?? "")) throw new Error("Ongeldig speakeradres");
        if (speaker.host !== host) {
          websocketGeneration += 1;
          boseWebSocket?.close();
          host = speaker.host;
          config.speakerName = speaker.name || config.speakerName;
          boseWebSocketConnected = false;
          console.log(`[bridge] Speakeradres ontvangen van iOS-app: ${host}`);
          connectWebSocket();
        }
        response.writeHead(204).end();
      } catch (error) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (request.method !== "GET" || request.url?.split("?")[0] !== "/health") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });
    response.end(JSON.stringify({
      ok: true,
      boseConnected: boseWebSocketConnected,
      speakerHost: host,
      speakerName: config.speakerName ?? "SoundTouch",
      uptimeSeconds: Math.round(process.uptime()),
      version: "1.3.0",
      activePreset: activePresetNumber ?? null,
      autoRecover: config.autoRecover !== false,
      presets: config.presets
    }));
  });
  healthServer.listen(port, "0.0.0.0", () => {
    console.log(`[bridge] Healthcheck actief op http://0.0.0.0:${port}/health`);
    bonjourProcess = spawn("/usr/bin/dns-sd", [
      "-R", config.bridgeName ?? "SoundTouch Preset Bridge",
      "_soundtouchbridge._tcp", "local.", String(port)
    ], { stdio: "ignore" });
    bonjourProcess.on("error", error => console.error(`[bridge] Bonjour kon niet starten: ${error.message}`));
  });
}

function startRecoveryMonitor() {
  if (config.autoRecover === false) {
    console.log("[bridge] Automatisch streamherstel is uitgeschakeld");
    return;
  }
  const intervalMs = Math.max(10, Number(config.recoveryCheckSeconds ?? 20)) * 1_000;
  console.log(`[bridge] Streamherstel controleert elke ${intervalMs / 1_000} seconden`);
  setTimeout(() => void checkPlaybackRecovery(), 3_000);
  recoveryTimer = setInterval(() => void checkPlaybackRecovery(), intervalMs);
}

async function checkPlaybackRecovery() {
  if (stopped || playInProgress) return;
  try {
    const response = await fetch(`http://${host}:8090/now_playing`, {
      signal: AbortSignal.timeout(5_000),
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const state = parseNowPlaying(await response.text());

    const matchingPreset = Object.entries(config.presets)
      .find(([, preset]) => preset.url === state.location)?.[0];
    if (matchingPreset) activePresetNumber = matchingPreset;

    const activePreset = activePresetNumber && config.presets[activePresetNumber];
    if (!activePreset || state.source !== "UPNP" || state.location !== activePreset.url) {
      lastPlaybackSecond = undefined;
      stalledChecks = 0;
      return;
    }

    let shouldRecover = state.status === "STOP_STATE";
    if (state.status === "PLAY_STATE" && Number.isFinite(state.second) && state.second > 0) {
      stalledChecks = state.second === lastPlaybackSecond ? stalledChecks + 1 : 0;
      lastPlaybackSecond = state.second;
      shouldRecover = stalledChecks >= 2;
    } else if (state.status !== "STOP_STATE") {
      lastPlaybackSecond = undefined;
      stalledChecks = 0;
    }

    const cooldownMs = Math.max(10, Number(config.recoveryCooldownSeconds ?? 30)) * 1_000;
    if (!shouldRecover || Date.now() - lastRecoveryAt < cooldownMs) return;
    lastRecoveryAt = Date.now();
    console.log(`[bridge] Stream ${activePreset.name} lijkt gestopt; automatisch opnieuw starten`);
    await playPreset(activePresetNumber);
  } catch (error) {
    console.error(`[bridge] Streamcontrole mislukt: ${error.message}`);
  }
}

function parseNowPlaying(xml) {
  const nowPlayingAttributes = xml.match(/<nowPlaying\b([^>]*)>/i)?.[1] ?? "";
  const contentAttributes = xml.match(/<ContentItem\b([^>]*)>/i)?.[1] ?? "";
  return {
    source: xmlAttribute(contentAttributes, "source") ?? xmlAttribute(nowPlayingAttributes, "source"),
    location: xmlAttribute(contentAttributes, "location"),
    status: xmlElementText(xml, "playStatus"),
    second: clockSeconds(xmlElementText(xml, "time"))
  };
}

function xmlAttribute(attributes, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = attributes.match(new RegExp(`\\b${escapedName}=["']([^"']*)["']`, "i"))?.[1];
  return value === undefined ? undefined : decodeXML(value);
}

function xmlElementText(xml, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = xml.match(new RegExp(`<${escapedName}\\b[^>]*>([^<]*)<\\/${escapedName}>`, "i"))?.[1];
  return value === undefined ? undefined : decodeXML(value).trim();
}

function clockSeconds(value) {
  if (!value) return undefined;
  const parts = value.split(":").map(Number);
  if (parts.some(part => !Number.isFinite(part))) return undefined;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function decodeXML(value) {
  return String(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

async function playPreset(number) {
  const preset = config.presets[String(number)];
  if (!preset) throw new Error(`Preset ${number} staat niet in config.json`);

  activePresetNumber = String(number);
  await playStream(preset.name, preset.url);
}

async function playStream(name, url) {
  if (!/^http:\/\//.test(url)) throw new Error("Gebruik voor deze SoundTouch een http://-stream");
  if (playInProgress) {
    console.log(`[bridge] Start van ${name} overgeslagen: er loopt al een afspeelactie`);
    return;
  }
  playInProgress = true;
  try {
    console.log(`[bridge] Start ${name}`);
    const metadata = didlMetadata(name, url);
    await soap("SetAVTransportURI", `
      <InstanceID>0</InstanceID>
      <CurrentURI>${xmlEscape(url)}</CurrentURI>
      <CurrentURIMetaData>${xmlEscape(metadata)}</CurrentURIMetaData>`);
    await soap("Play", `
      <InstanceID>0</InstanceID>
      <Speed>1</Speed>`);
    lastPlaybackSecond = undefined;
    stalledChecks = 0;
    console.log(`[bridge] ${name} speelt`);
  } finally {
    playInProgress = false;
  }
}

async function soap(action, argumentsXML) {
  const service = "urn:schemas-upnp-org:service:AVTransport:1";
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${service}">${argumentsXML}
    </u:${action}>
  </s:Body>
</s:Envelope>`;

  const response = await fetch(`http://${host}:8091/AVTransport/Control`, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "SOAPAction": `"${service}#${action}"`,
      "Connection": "close"
    },
    body,
    signal: AbortSignal.timeout(10_000)
  });
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`UPnP ${action} gaf HTTP ${response.status}: ${responseBody.slice(0, 500)}`);
  }
}

function didlMetadata(name, url) {
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
  <item id="0" parentID="0" restricted="1">
    <dc:title>${xmlEscape(name)}</dc:title>
    <upnp:class>object.item.audioItem.audioBroadcast</upnp:class>
    <res protocolInfo="http-get:*:audio/mpeg:*">${xmlEscape(url)}</res>
  </item>
</DIDL-Lite>`;
}

function extractPresetNumber(xml) {
  const selection = xml.match(/<nowSelectionUpdated\b[^>]*>([\s\S]*?)<\/nowSelectionUpdated>/i)?.[1];
  return selection?.match(/<preset\b[^>]*\bid=["']([1-6])["']/i)?.[1];
}

async function messageText(data) {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return String(data);
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function validateConfig(value) {
  if (!value?.presets) throw new Error("config.json mist presets");
  for (const [number, preset] of Object.entries(value.presets)) {
    if (!/^[1-6]$/.test(number) || !preset.name || !/^http:\/\//.test(preset.url)) {
      throw new Error(`Ongeldige configuratie voor preset ${number}; gebruik een naam en een http://-URL`);
    }
  }
}

function stop() {
  stopped = true;
  boseWebSocketConnected = false;
  if (recoveryTimer) clearInterval(recoveryTimer);
  bonjourProcess?.kill("SIGTERM");
  healthServer?.close();
  console.log("[bridge] Gestopt");
  process.exit(0);
}
