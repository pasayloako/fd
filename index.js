const express = require("express");
const path = require("node:path");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const COBALT_API_URL = (process.env.COBALT_API_URL || "https://api.cobalt.tools/").replace(/\/$/, "") + "/";
const COBALT_API_KEY = process.env.COBALT_API_KEY || "";
const REQUEST_TIMEOUT_MS = 30_000;

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

function normalizeFacebookUrl(input) {
  if (typeof input !== "string") {
    throw new Error("URL must be a string.");
  }

  let value = input.trim();
  if (!value) {
    throw new Error("Please enter a Facebook URL.");
  }

  // Make pasted links such as www.facebook.com/... valid URLs.
  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value}`;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("That does not look like a valid URL.");
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const isFacebook = hostname === "facebook.com" || hostname.endsWith(".facebook.com");
  const isFbWatch = hostname === "fb.watch" || hostname.endsWith(".fb.watch");

  if (!isFacebook && !isFbWatch) {
    throw new Error("Only Facebook and fb.watch URLs are accepted.");
  }

  // Tracking parameters do not identify the media and can make links harder to process.
  const removableParams = [
    "fbclid",
    "gclid",
    "dclid",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term"
  ];
  for (const key of removableParams) parsed.searchParams.delete(key);

  parsed.hash = "";
  return parsed.toString();
}

function getCobaltHeaders() {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    // Helps an authorized instance identify this client without exposing secrets.
    "User-Agent": "facebook-cobalt-downloader/1.0"
  };

  if (COBALT_API_KEY) {
    headers.Authorization = `Api-Key ${COBALT_API_KEY}`;
  }

  return headers;
}

app.post("/api/fix-url", (req, res) => {
  try {
    const url = normalizeFacebookUrl(req.body?.url);
    res.json({ url });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/download", async (req, res) => {
  let url;
  try {
    url = normalizeFacebookUrl(req.body?.url);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const quality = ["max", "2160", "1440", "1080", "720", "480", "360", "240", "144"]
    .includes(String(req.body?.quality))
    ? String(req.body.quality)
    : "720";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const cobaltResponse = await fetch(COBALT_API_URL, {
      method: "POST",
      headers: getCobaltHeaders(),
      body: JSON.stringify({
        url,
        videoQuality: quality,
        downloadMode: "auto",
        filenameStyle: "pretty"
      }),
      signal: controller.signal
    });

    const contentType = cobaltResponse.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
      ? await cobaltResponse.json()
      : { status: "error", error: { code: "cobalt.invalid_response" } };

    if (!cobaltResponse.ok || data.status === "error") {
      const authRequired = JSON.stringify(data).includes("api.auth");
      return res.status(cobaltResponse.status === 429 ? 429 : 502).json({
        error: authRequired
          ? "This Cobalt instance requires an API key or other authorization. Set COBALT_API_KEY on the server."
          : "The Cobalt instance could not process this Facebook URL.",
        details: data
      });
    }

    // Return the normalized source URL and Cobalt result to the frontend.
    return res.json({ sourceUrl: url, ...data });
  } catch (error) {
    if (error.name === "AbortError") {
      return res.status(504).json({ error: "The Cobalt request timed out." });
    }
    console.error("Cobalt request failed:", error);
    return res.status(502).json({
      error: "Could not connect to the Cobalt API. Check COBALT_API_URL and your network."
    });
  } finally {
    clearTimeout(timeout);
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, cobaltApi: COBALT_API_URL });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Facebook downloader running at http://localhost:${PORT}`);
  console.log(`Cobalt API: ${COBALT_API_URL}`);
});
