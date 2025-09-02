import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import http from "http";
import fs from "fs";
import path from "path";

const TOKEN_PATH = process.env.GOOGLE_OAUTH_TOKEN_PATH || path.resolve(process.cwd(), "google_oauth_token.json");

function getClientIdSecret() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID as string;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET as string;
  if (!clientId || !clientSecret) {
    throw new Error("Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET in environment");
  }
  return { clientId, clientSecret };
}

export function createOAuth2Client(redirectUri: string): OAuth2Client {
  const { clientId, clientSecret } = getClientIdSecret();
  return new google.auth.OAuth2({ clientId, clientSecret, redirectUri });
}

export async function loadSavedTokens(): Promise<null | any> {
  try {
    const raw = await fs.promises.readFile(TOKEN_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveTokens(tokens: any): Promise<void> {
  await fs.promises.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf8");
}

export async function getAuthorizedOAuth2Client(): Promise<OAuth2Client> {
  // Use localhost loopback redirect for installed-app flow (no registration needed for desktop type)
  const redirectUri = "http://127.0.0.1:53682";
  const oAuth2Client = createOAuth2Client(redirectUri);
  const tokens = await loadSavedTokens();
  if (!tokens) {
    throw new Error(
      `No OAuth tokens found. Run \"bun run drive:auth\" to complete the one-time Google authorization.`
    );
  }
  oAuth2Client.setCredentials(tokens);
  return oAuth2Client;
}

export async function runInteractiveAuth(): Promise<void> {
  const redirectUri = "http://127.0.0.1:53682";
  const oAuth2Client = createOAuth2Client(redirectUri);

  const scopes = [
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/drive.readonly",
  ];

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
    include_granted_scopes: true,
    prompt: "consent",
  });

  console.log("\nAuthorize this app by visiting this URL:\n", authUrl, "\n");
  console.log("Waiting on http://127.0.0.1:53682 for Google to redirect with the code...");

  const code: string = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        if (!req.url) return;
        const url = new URL(req.url, redirectUri);
        if (url.pathname === "/" && url.searchParams.has("code")) {
          const c = url.searchParams.get("code") as string;
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("Authorization received. You can close this window and return to the terminal.");
          server.close();
          resolve(c);
        } else {
          res.writeHead(404);
          res.end("Not Found");
        }
      } catch (e) {
        reject(e);
      }
    });
    server.listen(53682, "127.0.0.1");
  });

  const { tokens } = await oAuth2Client.getToken(code);
  await saveTokens(tokens);
  console.log("✅ OAuth tokens saved to:", TOKEN_PATH);
}
