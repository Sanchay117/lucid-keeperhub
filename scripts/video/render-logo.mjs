import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const dir = new URL("../../docs/brand/", import.meta.url).pathname;
const svg = readFileSync(`${dir}logo.svg`, "utf8");
const browser = await chromium.launch();
for (const size of [1024, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('width="1024" height="1024"', `width="${size}" height="${size}"`)}</body></html>`);
  await page.screenshot({ path: `${dir}logo-${size}.png`, omitBackground: true });
  await page.close();
}
await browser.close();
console.log("rendered");
