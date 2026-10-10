import type { Page } from "@playwright/test";

const MARK = "covel-policy-violation";

/**
 * Collect every Content-Security-Policy violation of the page and its frames
 * (plugin frames included). Call before the first navigation; assert that the
 * returned list is empty at the end of the test.
 *
 * Two sources, because either can miss one: the `securitypolicyviolation`
 * event of each document, and the browser's own console report.
 */
export async function watchPolicyViolations(page: Page): Promise<string[]> {
  const violations: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith(MARK) || /Content Security Policy/i.test(text))
      violations.push(text);
  });
  await page.addInitScript((mark) => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.warn(
        `${mark} ${JSON.stringify({
          directive: event.effectiveDirective,
          blocked: event.blockedURI,
          document: event.documentURI,
          source: `${event.sourceFile}:${event.lineNumber}`,
          sample: event.sample,
        })}`,
      );
    });
  }, MARK);
  return violations;
}
