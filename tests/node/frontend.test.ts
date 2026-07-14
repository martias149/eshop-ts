import { readFileSync } from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  ADMIN_IMAGE_UPLOAD_FIELD,
  API_BASE,
  SAMPLE_CATEGORY,
  SAMPLE_PRODUCT,
} from "../fixtures/api-contract";

const PUBLIC = path.resolve(__dirname, "../../public");
const read = (f: string) => readFileSync(path.join(PUBLIC, f), "utf8");

// Renders the real public/app.js against a payload shaped like the real API
// (tests/contract.test.ts proves the API matches that shape). This is the half
// that pins what the frontend *reads* — the half that was missing when the
// catalog shipped with every <img> broken because app.js read `.image` off an
// object the API serializes with `url`.
async function renderRoute(hash: string, routes: Record<string, unknown>) {
  const dom = new JSDOM(read("index.html"), {
    url: `http://localhost/${hash}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;

  const seen: string[] = [];
  // @ts-expect-error assigning a stub onto the jsdom window
  window.fetch = async (input: string) => {
    const url = String(input);
    seen.push(url);
    const key = Object.keys(routes).find((r) => url === `${API_BASE}${r}`);
    if (key === undefined) {
      return { ok: false, status: 404, json: async () => ({ detail: "not found" }) };
    }
    return { ok: true, status: 200, json: async () => routes[key] };
  };

  window.eval(read("app.js"));
  // app.js kicks off route() on load; let its fetches settle.
  await new Promise((r) => window.setTimeout(r, 50));

  return { window, document: window.document, seen };
}

describe("the frontend reads the keys the API actually emits", () => {
  it("renders product images from `url` (not `.image`)", async () => {
    const { document } = await renderRoute("#/", {
      "/products": [SAMPLE_PRODUCT],
      "/categories": [SAMPLE_CATEGORY],
    });

    const img = document.querySelector("#app img");
    expect(img, "catalog rendered no <img> at all").not.toBeNull();

    const src = img!.getAttribute("src");
    expect(src).toBe(SAMPLE_PRODUCT.images[0].url);
    expect(src, "img src is empty/undefined — the frontend read a key the API does not emit").toBeTruthy();
    expect(src).not.toMatch(/undefined/);
  });

  it("renders the product name and price from the payload", async () => {
    const { document } = await renderRoute("#/", {
      "/products": [SAMPLE_PRODUCT],
      "/categories": [SAMPLE_CATEGORY],
    });

    const html = document.querySelector("#app")!.innerHTML;
    expect(html).toContain(SAMPLE_PRODUCT.name);
    expect(html).toContain(SAMPLE_PRODUCT.price);
    expect(html).not.toMatch(/undefined/);
  });

  it("calls the API same-origin, so no CORS layer is needed", async () => {
    const { seen } = await renderRoute("#/", {
      "/products": [SAMPLE_PRODUCT],
      "/categories": [SAMPLE_CATEGORY],
    });

    expect(seen.length).toBeGreaterThan(0);
    for (const url of seen) {
      expect(url, `${url} is absolute — that reintroduces cross-origin requests`).toMatch(/^\/api\//);
    }
  });
});

describe("the admin panel agrees with the admin API", () => {
  it("uploads the image under the multipart field the backend reads", () => {
    const adminJs = read("admin.js");

    // POST /api/admin/products/:id/images does `body["file"]`. Sending it as
    // `image` — which is what shipped first — 400s on every upload.
    const appended = [...adminJs.matchAll(/FormData\(\)[\s\S]{0,400}?\.append\(\s*["'](\w+)["']\s*,\s*\w*[Ff]ile/g)].map(
      (m) => m[1],
    );

    expect(appended.length, "found no FormData().append(<field>, file) in admin.js").toBeGreaterThan(0);
    for (const field of appended) {
      expect(field).toBe(ADMIN_IMAGE_UPLOAD_FIELD);
    }
  });

  it("gates the admin panel on is_staff, which the auth response must carry", () => {
    expect(read("admin.js")).toMatch(/is_staff/);
  });
});
