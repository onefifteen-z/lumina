import { describe, it, expect } from "vitest";
import React from "react";
import { FoxThinkingIndicator, FoxFaceGraphic } from "./FoxThinkingIndicator";
import DefaultExport from "./FoxThinkingIndicator";

// ── Helpers to traverse React element trees (no DOM needed) ──

type ReactNode =
  | React.ReactElement
  | string
  | number
  | boolean
  | null
  | undefined;

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

function findByType(
  root: React.ReactElement,
  type: string,
): React.ReactElement[] {
  return flattenElements(root).filter((el) => el.type === type);
}

function findByClassName(
  root: React.ReactElement,
  cls: string,
): React.ReactElement[] {
  return flattenElements(root).filter((el) => {
    const cn = (el.props as Record<string, unknown>)?.className;
    return typeof cn === "string" && cn.split(/\s+/).includes(cls);
  });
}

// ── Tests ──

describe("FoxThinkingIndicator", () => {
  it("is exported as a named export", () => {
    expect(FoxThinkingIndicator).toBeDefined();
    expect(typeof FoxThinkingIndicator).toBe("function");
  });

  it("is exported as the default export", () => {
    expect(DefaultExport).toBe(FoxThinkingIndicator);
  });

  describe("default (large) variant", () => {
    const tree = FoxThinkingIndicator({});

    it('container has aria-label="Thinking" and role="status"', () => {
      expect(tree.props["aria-label"]).toBe("Thinking");
      expect(tree.props.role).toBe("status");
    });

    it('SVG has aria-hidden="true" and viewBox="0 0 680 680"', () => {
      const svg = findByType(tree, "svg")[0];
      expect(svg.props["aria-hidden"]).toBe("true");
      expect(svg.props.viewBox).toBe("0 0 680 680");
    });
  });

  describe('large variant (size="large")', () => {
    const tree = FoxThinkingIndicator({ size: "large" });

    it("SVG renders at 80×80", () => {
      const svg = findByType(tree, "svg")[0];
      expect(svg.props.width).toBe(80);
      expect(svg.props.height).toBe(80);
    });

    it("renders 3 thinking dots", () => {
      const dots = findByClassName(tree, "fox-dot");
      expect(dots).toHaveLength(3);
    });

    it("renders glow ring", () => {
      const glowRings = findByClassName(tree, "fox-glow-ring");
      expect(glowRings.length).toBe(1);
    });

    it('renders "Thinking" label', () => {
      const labels = findByClassName(tree, "fox-label");
      expect(labels.length).toBe(1);
      expect(labels[0].props.children).toBe("Thinking");
    });
  });

  describe('small variant (size="small")', () => {
    const tree = FoxThinkingIndicator({ size: "small" });

    it("SVG renders at 44×44", () => {
      const svg = findByType(tree, "svg")[0];
      expect(svg.props.width).toBe(44);
      expect(svg.props.height).toBe(44);
    });

    it("renders 3 thinking dots", () => {
      const dots = findByClassName(tree, "fox-dot");
      expect(dots).toHaveLength(3);
    });

    it("does not render glow ring", () => {
      const glowRings = findByClassName(tree, "fox-glow-ring");
      expect(glowRings).toHaveLength(0);
    });

    it('does not render "Thinking" label', () => {
      const labels = findByClassName(tree, "fox-label");
      expect(labels).toHaveLength(0);
    });
  });

  describe("ears have separate animation classes", () => {
    const graphic = FoxFaceGraphic({ animated: true });
    it("renders both fox-ear-left and fox-ear-right elements", () => {
      const left = findByClassName(graphic, "fox-ear-left");
      const right = findByClassName(graphic, "fox-ear-right");
      expect(left.length).toBeGreaterThanOrEqual(1);
      expect(right.length).toBeGreaterThanOrEqual(1);
    });
  });
});
