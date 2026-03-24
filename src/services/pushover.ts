import { Injector } from "../config/Injector.js";

export interface PushoverMessage {
  message: string;
  title: string;
  url?: string;
  url_title?: string;
  priority?: number;
  sound?: string;
  timestamp?: number;
  token?: string;
}

function getCredentials(): { token: string | undefined; user: string | undefined } {
  try {
    const config = Injector.config;
    return { token: config.PUSHOVER_TOKEN, user: config.PUSHOVER_USER };
  } catch {
    return {
      token: process.env.PUSHOVER_TOKEN,
      user: process.env.PUSHOVER_USER,
    };
  }
}

export async function notify(message: PushoverMessage): Promise<void> {
  const creds = getCredentials();
  const token = message.token ?? creds.token;
  const user = creds.user;

  // Skip silently if Pushover credentials are not configured
  if (!token || !user) return;

  const body = new URLSearchParams({
    token,
    user,
    message: message.message,
    ...(message.title && { title: message.title }),
    ...(message.url && { url: message.url }),
    ...(message.url_title && { url_title: message.url_title }),
    ...(message.priority !== undefined && {
      priority: message.priority.toString(),
    }),
    ...(message.sound && { sound: message.sound }),
    ...(message.timestamp && { timestamp: message.timestamp.toString() }),
  });

  const res = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const data = await res.text();
    throw new Error(`Pushover API returned status code ${res.status}: ${data}`);
  }
}
