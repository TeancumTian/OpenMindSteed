import { expect, test } from "@playwright/test";

test("workspace supports core navigation and visual smoke capture", async ({ page }, testInfo) => {
  await page.goto("/");

  await expect(page.getByText("OpenMindSteed").first()).toBeVisible();
  await expect(page.getByRole("complementary", { name: "知识树" })).toBeVisible();
  await expect(page.getByRole("region", { name: "知识图谱" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "节点对话" })).toBeVisible();

  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  await expect(page.getByLabel("搜索节点")).toBeVisible();
  await page.getByLabel("搜索节点").fill("Obsidian");
  await expect(
    page
      .locator(".command-results")
      .getByRole("button", { name: /Obsidian/i })
      .first(),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "focus" }).click();
  await expect(page.getByRole("button", { name: "focus" })).toHaveClass(/active/u);

  await page.getByLabel("新知识树").fill("自动首问测试");
  await page.getByRole("button", { name: "创建知识树" }).click();
  await expect(page.locator(".message.user")).toContainText("自动首问测试");
  await expect(
    page.locator(".message.assistant").filter({ hasText: "关于“自动首问测试”" }),
  ).toBeVisible({
    timeout: 5000,
  });
  await expect(page.locator(".suggestion").first()).toBeVisible();

  await page.getByRole("button", { name: "设置" }).click();
  await expect(page.getByRole("dialog").filter({ hasText: "Provider & Sync" })).toBeVisible();
  await expect(page.getByLabel("OpenMindSteed backup")).toBeVisible();

  const screenshot = await page.screenshot({ fullPage: true });
  await testInfo.attach("workspace-smoke.png", {
    body: screenshot,
    contentType: "image/png",
  });
});
