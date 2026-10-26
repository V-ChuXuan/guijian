import { describe, expect, it } from "vitest";

import appStyles from "./App.css?raw";

function ruleBody(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = appStyles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));

  expect(match, `missing CSS rule for ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("review group state styling", () => {
  it("keeps the final confirmation path readable and the dialog inside the viewport", () => {
    expect(ruleBody(".single-cleanup-dialog__file span")).toMatch(/white-space:\s*normal/);
    expect(ruleBody(".single-cleanup-dialog__file span")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(ruleBody(".single-cleanup-dialog")).toMatch(/max-height:\s*calc\(100dvh - 48px\)/);
    expect(ruleBody(".single-cleanup-dialog")).toMatch(/overflow-y:\s*auto/);
  });
  it("does not draw a persistent left accent on expanded groups", () => {
    const leftBorderProperty = /border-(?:left|inline-start)\s*:/;

    expect(ruleBody(".review-group__head")).not.toMatch(leftBorderProperty);
    expect(ruleBody(".review-group.is-open .review-group__head")).not.toMatch(
      leftBorderProperty,
    );
  });

  it("keeps the result toolbar compact with a quiet label and separated actions", () => {
    expect(ruleBody(".review-toolbar")).toMatch(/min-height:\s*48px/);
    expect(ruleBody(".review-result-anchor__label")).toMatch(/font-size:\s*14px/);
    expect(ruleBody(".review-result-anchor__label")).toMatch(/font-weight:\s*600/);
    expect(ruleBody(".review-result-anchor__count")).toMatch(/font-size:\s*13px/);
    expect(ruleBody(".review-result-anchor__count")).toMatch(/font-weight:\s*400/);
    expect(ruleBody(".review-result-anchor__count")).toMatch(/color:\s*var\(--text-muted\)/);
    expect(ruleBody(".review-toolbar__actions")).toMatch(/gap:\s*24px/);
  });
});
