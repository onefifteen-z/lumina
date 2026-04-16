import { describe, it, expect } from "vitest";
import React from "react";
import { FoxThinkingIndicator } from "./FoxThinkingIndicator";
import DefaultExport from "./FoxThinkingIndicator";

// ── Helpers to traverse React element trees (no DOM needed) ──

type ReactNode =
  | React.ReactElement
  | string
  | number
  | boolean
  | null
  | undefined;

/** Flatten all React elements in the tree into a flat array. */
function flattenElements(node: ReactNode): React.ReactElement[] {
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const result: React.ReactElement[] = [node];
  const children = node.props?.children;
  if (children == null) return result;
  if (Array.isArray(children)) {
    for (const child of children) {
      result.push(...flattenElements(child));
    }
  } else {
    result.push(...flattenElements(children as ReactNode));
  }
  return result;
}

/** Find all elements whose props match every key/value in `match`. */
function findByProps(
  root: React.ReactElement,
  match: Record<string, unknown>,
): React.ReactElement[] {
  return flattenElements(root).filter((el) =>
    Object.entries(match).every(
      ([k, v]) => (el.props as Record<string, unknown>)?.[k] === v,
    ),
  );
}

/** Find all elements of a given intrinsic type (e.g. 'svg', 'div', 'g'). */
function findByType(
  root: React.ReactElement,
  type: string,
): React.ReactElement[] {
  return flattenElements(root).filter((el) => el.type === type);
}

/** Find elements whose className includes the given substring. */
function findByClassName(
  root: React.ReactElement,
  cls: string,
): React.ReactElement[] {
  return flattenElements(root).filter((el) => {
    const cn = (el.props as Record<string, unknown>)?.className;
    return typeof cn === "string" && cn.includes(cls);
  });
}

/** Get the style object from an element. */
function getStyle(el: React.ReactElement): Record<string, unknown> {
  return (
    ((el.props as Record<string, unknown>)?.style as Record<string, unknown>) ??
    {}
  );
}

// ── Tests ──

describe("FoxThinkingIndicator", () => {
  // ── Exports ──

  it("is exported as a named export", () => {
    expect(FoxThinkingIndicator).toBeDefined();
    expect(typeof FoxThinkingIndicator).toBe("function");
  });

  it("is exported as the default export", () => {
    expect(DefaultExport).toBeDefined();
    expect(DefaultExport).toBe(FoxThinkingIndicator);
  });

  // ── Default (large) variant — accessibility ──

  describe("default (large) variant", () => {
    const tree = FoxThinkingIndicator({});

    it('container has aria-label="Thinking" and role="status"', () => {
      expect(tree.props["aria-label"]).toBe("Thinking");
      expect(tree.props.role).toBe("status");
    });

    it('SVG has aria-hidden="true" and viewBox="0 0 200 200"', () => {
      const svgs = findByType(tree, "svg");
      expect(svgs.length).toBeGreaterThanOrEqual(1);
      const svg = svgs[0];
      expect(svg.props["aria-hidden"]).toBe("true");
      expect(svg.props.viewBox).toBe("0 0 200 200");
    });
  });

  // ── Large variant ──

  describe('large variant (size="large")', () => {
    const tree = FoxThinkingIndicator({ size: "large" });

    it("SVG renders at 80×80", () => {
      const svg = findByType(tree, "svg")[0];
      expect(svg.props.width).toBe(80);
      expect(svg.props.height).toBe(80);
    });

    it("renders 3 thinking dots", () => {
      const dots = findByClassName(tree, "fox-dot-bounce");
      expect(dots).toHaveLength(3);
    });

    it("renders glow ring", () => {
      const glowRings = findByClassName(tree, "fox-glow-pulse");
      expect(glowRings.length).toBeGreaterThanOrEqual(1);
    });

    it('renders "Thinking" label', () => {
      const labels = findByClassName(tree, "fox-label-fade");
      expect(labels.length).toBeGreaterThanOrEqual(1);
      const label = labels[0];
      expect(label.props.children).toBe("Thinking");
    });
  });

  // ── Small variant ──

  describe('small variant (size="small")', () => {
    const tree = FoxThinkingIndicator({ size: "small" });

    it("SVG renders at 44×44", () => {
      const svg = findByType(tree, "svg")[0];
      expect(svg.props.width).toBe(44);
      expect(svg.props.height).toBe(44);
    });

    it("renders 3 thinking dots", () => {
      const dots = findByClassName(tree, "fox-dot-bounce");
      expect(dots).toHaveLength(3);
    });

    it("does not render glow ring", () => {
      const glowRings = findByClassName(tree, "fox-glow-pulse");
      expect(glowRings).toHaveLength(0);
    });

    it('does not render "Thinking" label', () => {
      const labels = findByClassName(tree, "fox-label-fade");
      expect(labels).toHaveLength(0);
    });
  });

  // ── Thinking dots staggered delays ──

  describe("thinking dots animation delays", () => {
    const tree = FoxThinkingIndicator({ size: "large" });
    const dots = findByClassName(tree, "fox-dot-bounce");

    it("3 dots have staggered delays of 0s, 0.15s, 0.3s", () => {
      const delays = dots.map((d) => getStyle(d).animationDelay);
      expect(delays).toEqual(["0s", "0.15s", "0.3s"]);
    });
  });

  // ── Ear animation delays ──

  describe("ear elements have different animation delays", () => {
    const tree = FoxThinkingIndicator({ size: "large" });
    const ears = findByClassName(tree, "fox-ear-wiggle");

    it("two ear groups exist with different delays", () => {
      expect(ears).toHaveLength(2);
      const leftDelay = getStyle(ears[0]).animationDelay;
      const rightDelay = getStyle(ears[1]).animationDelay;
      expect(leftDelay).not.toBe(rightDelay);
    });
  });
});
