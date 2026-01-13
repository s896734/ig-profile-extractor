import express from "express";
import { z } from "zod";
// 改用 puppeteer-extra 以繞過偵測
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

// 啟用隱身模式
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

const schema = z.object({ url: z.string().url() });

// --- 保留你原本優秀的解析邏輯 Start ---
function parseCompactNumber(input) {
  if (!input) return null;
  let s = String(input).trim();
  s = s.replace(/,/g, "").replace(/\s+/g, "");

  const mZh = s.match(/^(\d+(?:\.\d+)?)(萬|万|億|亿)$/);
  if (mZh) {
    const n = Number(mZh[1]);
    const unit = mZh[2];
    if (!Number.isFinite(n)) return null;
    if (unit === "萬" || unit === "万") return Math.round(n * 1e4);
    if (unit === "億" || unit === "亿") return Math.round(n * 1e8);
  }

  const mEn = s.match(/^(\d+(?:\.\d+)?)([KMB])$/i);
  if (mEn) {
    const n = Number(mEn[1]);
    const unit = mEn[2].toUpperCase();
    if (!Number.isFinite(n)) return null;
    if (unit === "K") return Math.round(n * 1e3);
    if (unit === "M") return Math.round(n * 1e6);
    if (unit === "B") return Math.round(n * 1e9);
  }

  const n = Number(s);
  if (Number.isFinite(n)) return Math.round(n);
  return null;
}

function extractCountsFromHtml(html) {
  const mFollowers = html.match(/"edge_followed_by"\s*:\s*\{\s*"count"\s*:\s*(\d+)\s*\}/);
  const mFollowing = html.match(/"edge_follow"\s*:\s*\{\s*"count"\s*:\s*(\d+)\s*\}/);
  const mPosts = html.match(/"edge_owner_to_timeline_media"\s*:\s*\{\s*"count"\s*:\s*(\d+)\s*\}/);

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
  const out = { followers: null, following: null, posts: null };

  const f1 = raw.match(/([\d.,]+[KMB]?|\d+(?:\.\d+)?[KMB]?)\s*Followers/i);
  const f2 = raw.match(/([\d.,]+[KMB]?|\d+(?:\.\d+)?[KMB]?)\s*Following/i);
  const f3 = raw.match(/([\d.,]+[KMB]?|\d+(?:\.\d+)?[KMB]?)\s*Posts/i);

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
// --- 保留解析邏輯 End ---

app.post("/profile", async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body. Expect { url }" });

  const url = parsed.data.url;
  if (!url.includes("instagram.com/")) {
    return res.status(400).json({ error: "Only instagram.com URLs are supported" });
  }

  let browser;
  try {
    // 啟動 Puppeteer (Stealth 模式自動生效)
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage();

    // 優化：設定 Viewport 與 Header
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
    });

    // --- 關鍵修改：注入 Session Cookie ---
    // 在 Zeabur 環境變數設定 IG_SESSION_ID
    if (process.env.IG_SESSION_ID) {
      console.log("Injecting Session Cookie...");
      await page.setCookie({
        name: "sessionid",
        value: process.env.IG_SESSION_ID,
        domain: ".instagram.com",
        path: "/",
        secure: true,
        httpOnly: true,
      });
    } else {
      console.log("WARNING: No IG_SESSION_ID provided. Scraping might fail.");
    }

    // 攔截資源請求以加速 (圖片、字型、樣式表)
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (["image", "font", "media", "stylesheet"].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // 導航到頁面
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // 檢查是否仍被導向登入頁
    const finalUrl = page.url();
    const looksLogin =
      finalUrl.includes("/accounts/login") ||
      finalUrl.includes("/login") ||
      finalUrl.includes("challenge");

    // 抓取 Meta Data
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

    // 1) HTML JSON count
    const fromHtml = extractCountsFromHtml(html);
    // 2) Meta text fallback
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
        source: (fromHtml.followers || fromHtml.following || fromHtml.posts) ? "html_json" : "meta_text_or_null",
        usingCookie: !!process.env.IG_SESSION_ID
      },
      note: looksLogin
        ? "Redirected to login. Please update IG_SESSION_ID in Zeabur variables."
        : "Success.",
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("listening on", PORT));
