export function kebabToTitleCase(str: string): string {
  return str
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function toTitleCase(str: string): string {
  return str
    .toLowerCase()
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function truncate(str: string, length: number, suffix = "..."): string {
  return str.length > length ? `${str.slice(0, length - suffix.length)}${suffix}` : str;
}

export function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function formatDuration(seconds: number | undefined): string {
  if (!seconds) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

export function generateRandomString(length = 6): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function getTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let title = parsed.hostname.replace(/^www\./, "");
    title = title.charAt(0).toUpperCase() + title.slice(1);

    const segments = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((s) => s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));

    if (segments.length > 0) {
      title += ` - ${segments.join(" / ")}`;
    }
    return title;
  } catch {
    return "Untitled";
  }
}
