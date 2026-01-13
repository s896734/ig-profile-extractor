import express from "express";
import { z } from "zod";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

const schema = z.object({ url: z.string().url() });

app.post("/profile", async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body. Expect { url }" });

  const url = parsed.data.url;
  if (!url.includes("instagram.com/")) return res.status(400).json({ error: "Only instagram.com URLs are supported" });

  let browser;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const page = await browser.newPage({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    const meta = await page.evaluate(() => {
      const get = (name, attr = "name") => {
        const el = document.querySelector(`meta[${attr}="${name}"]`);
        return el?.getAttribute("content") || "";
      };
      return {
        title: document.title || "",
        description: get("description", "name"),
        ogDescription: get("og:description", "property"),
        ogTitle: get("og:title", "property")
      };
    });

    const raw = (meta.ogDescription || meta.description || "").replace(/\s+/g, " ").trim();

    const numbers = { followers: null, following: null, posts: null };
    const m1 = raw.match(/([\d.,KMB萬亿]+)\s+Followers/i);
    const m2 = raw.match(/([\d.,KMB萬亿]+)\s+Following/i);
    const m3 = raw.match(/([\d.,KMB萬亿]+)\s+Posts/i);
    if (m1) numbers.followers = m1[1];
    if (m2) numbers.following = m2[1];
    if (m3) numbers.posts = m3[1];

    res.json({
      inputUrl: url,
      title: meta.title,
      ogTitle: meta.ogTitle,
      rawDescription: raw,
      parsed: numbers,
      note: "Best-effort parse. IG may show login wall / vary by locale. Use rawDescription as fallback."
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    if (browser) await browser.close();
  }
});

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, () => console.log(`Server listening on ${port}`));
