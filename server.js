import express from "express";
import { z } from "zod";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

const schema = z.object({ url: z.string().url() });

function parseCompactNumber(input) {
  if (!input) return null;
  let s = String(input).trim();

  // remove commas/spaces
  s = s.replace(/,/g, "").replace(/\s+/g, "");

  // Chinese units
  // 1.2萬 / 1萬 / 2億 / 2.3亿 / 1.1万
  const mZh = s.match(/^(\d+(?:\.\d+)?)(萬|万|億|亿)$/);
  if (mZh) {
    const n = Number(mZh[1]);
    const unit = mZh[2];
    if (!Number.isFinite(n)) return null;
    if (unit === "萬" || unit === "万") return Math.round(n * 1e4);
    if (unit === "億" || unit === "亿") return Math.round(n * 1e8);
  }

  // K/M/B units
  const mEn = s.match(/^(\d+(?:\.\d+)?)([KMB])$/i);
  if (mEn) {
    const n = Number(mEn[1]);
    const unit = mEn[2].toUpperCase();
    if (!Number.isFinite(n)) return null;
    if (unit === "K") return Math.round(n * 1e3);
    if (unit === "M") return Math.round(n * 1e6);
    if (unit === "B") return Math.round(n * 1e9);
  }

  // plain number
  const n = Number(s);
  if (Number.isFinite(n)) return Math.round(n);
  return null;
}

function extractCountsFromHtml(html) {
  // 先抓最常見的三個
  const mFollowers = html.match(/"edge_followed_by"\s*:\s*\{\s*"count"\s*:\s*(\d+)\s*\}/);
  const mFollowing = html.match(/"edge_follow"\s*:\s*\{\s*"count"\s*:\s*(\d+)\s*\}/);
  const mPosts = html.match(/"edge_owner_to_timeline_media"\s*:\s*\{\s*"count"\s*:\s*(\d+)\s*\}/);

  // 某些版本可能是 follower_count / following_count / media_count
  const mFollowers2 = html.match(/"follower_count"\s*:\s*(\d+)/);
  const mFollowing2 = html.match(/"following_count"\s*:\s*(\d+)/);
  const mPosts2 = html.match(/"media_count"\s*:\s*(\d+)/);

  return {
    followers: mFollowers ? Number(mFollowers[1]) : (mFollowers2 ? Number(mFollowers2[1]) : null),
    following: mFollowing ? Number(mFollowing[1]) : (mFollowing2 ? Number(mFollowing2[1]) : null),
    posts: mPosts ? Number(mPosts[1]) : (mPosts2 ? Number(mPosts2[1]) : null),
  };
}

function extractCountsFromMetaText(raw) {
  // raw 可能是 "1,234 Followers, 56 Following, 78 Posts - ..."
  // 或其他語系。這裡同時支援英文 + 中文常見寫法
  const out = { followers: null, following: null, posts: null };

  // English
  const f1 = raw.match(/([\d.,]+[KMB]?|\d+(?:\.\d+)?[KMB]?)\s*Followers/i);
  const f2 = raw.match(/([\d.,]+[KMB]?|\d+(?:\.\d+)?[KMB]?)\s*Following/i);
  const f3 = raw.match(/([\d.,]+[KMB]?|\d+(?:\.\d+)?[KMB]?)\s*Posts/i);

  // Chinese: "1.2萬 位粉絲" / "追蹤中 123" / "貼文 45"
  const z1 = raw.match(/([\d.,]+(?:\.\d+)?(?:萬|万|億|亿)?)\s*(?:位)?粉絲/);
  const z2 = raw.match(/追蹤中?\s*([\d.,]+(?:\.\d+)?(?:萬|万|億|亿)?)/);
  const z3 = raw.match(/貼文\s*([\d.,]+(?:\.\d+)?(?:萬|万|億|亿)?)/);

  const followersText = (f1?.[1] || z1?.[1] || "").trim();
  const followingText = (f2?.[1] || z2?.[1] || "").trim();
  const postsText = (f3?.[1] || z3?.[1] || "").trim();

  out.followers = parseCompactNumber(followersText);
  out.following = parseCompactNumber(followingText);
  out.posts = parseCompactNumber(postsText);

  return out;
}

app.post("/profile", async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body. Expect { url }" });

  const url = parsed.data.url;
  if (!url.includes("instagram.com/")) {
    return res.status(400).json({ error: "Only instagram.com URLs are supported" });
  }

  let browser;
  try {
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      headless: true,
    });

    const context = await browser.newContext({
      locale: "en-US",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
      },
      viewport: { width: 1280, height: 720 },
    });

    const page = await context.newPage();

    // 加速 & 少被擋：阻擋圖片/字型/影片
    await page.route("**/*", (route) => {
      const rt = route.request().resourceType();
      if (["image", "media", "font"].includes(rt)) return route.abort();
      return route.continue();
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    // 如果被導去 login，直接回報（讓你 n8n 可做 fallback）
    const finalUrl = page.url();
    const looksLogin =
      finalUrl.includes("/accounts/login") ||
      finalUrl.includes("/login") ||
      finalUrl.includes("challenge");

    const meta = await page.evaluate(() => {
      const get = (name, attr = "name") => {
        const el = document.querySelector(`meta[${attr}="${name}"]`);
        return el?.getAttribute("content") || "";
      };
      return {
        title: document.title || "",
        description: get("description", "name"),
        ogDescription: get("og:description", "property"),
        ogTitle: get("og:title", "property"),
      };
    });

    const raw = (meta.ogDescription || meta.description || "")
      .replace(/\s+/g, " ")
      .trim();

    const html = await page.content();

    // 1) HTML JSON count 優先
    const fromHtml = extractCountsFromHtml(html);

    // 2) meta 文字 fallback
    const fromMeta = extractCountsFromMetaText(raw);

    const numbers = {
      followers: fromHtml.followers ?? fromMeta.followers,
      following: fromHtml.following ?? fromMeta.following,
      posts: fromHtml.posts ?? fromMeta.posts,
    };

    res.json({
      inputUrl: url,
      finalUrl,
      title: meta.title,
      ogTitle: meta.ogTitle,
      rawDescription: raw,
      parsed: numbers,
      debug: {
        looksLogin,
        source:
          (fromHtml.followers || fromHtml.following || fromHtml.posts) ? "html_json" : "meta_text_or_null",
      },
      note:
        looksLogin
          ? "Redirected to login/challenge. Counts may be unavailable without authenticated session."
          : "Parsed via HTML JSON first; fallback to meta description.",
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("listening on", PORT));
