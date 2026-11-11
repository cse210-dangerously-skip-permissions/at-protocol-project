import { expect, test } from "@playwright/test";

// Example spec: replace with story-linked specs such as
// `e2e/publish-verify.spec.ts`. There is no web app yet, so this runs
// against a placeholder page. Story specs can also skip the `page`
// fixture and drive the `trustlab` CLI instead.
test("placeholder page renders in Chromium", async ({ page }) => {
  await page.setContent(
    "<main><h1>trustlab</h1><p data-testid='verdict'>accept</p></main>",
  );

  await expect(page.getByRole("heading", { name: "trustlab" })).toBeVisible();
  await expect(page.getByTestId("verdict")).toHaveText("accept");
});
